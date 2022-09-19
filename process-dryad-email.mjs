// Documentation references:
//
// Jira API
// https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
//
// Google Apps Script
// https://developers.google.com/apps-script/overview
//
// Gmail Service
// https://developers.google.com/apps-script/reference/gmail
//
// Node.js
// https://nodejs.org/api/
//
// node-fetch
// https://www.npmjs.com/package/node-fetch

// Platform selection and abstraction

const using_nodejs = false;
// Uncomment if running under Node.js:
// import fetch from "node-fetch";
// import { readFile } from "node:fs/promises";

const base64_encode_fn = using_nodejs ? btoa : Utilities.base64Encode;
const payload_field = using_nodejs ? "body" : "payload";
const fetch_fn = using_nodejs ? fetch : UrlFetchApp.fetch;
const status_fn = (r) => using_nodejs ? r.status : r.getResponseCode();
const text_content_fn = (r) => using_nodejs ? r.text() : r.getContentText();
const paragraph_separator = using_nodejs ? /\n+/ : /\n{2,}/;

// Global constants

const base_url = "https://ucsb-atlas.atlassian.net/rest/api/3";
const auth = base64_encode_fn("email_address:api_token");

const dataset_name_field = "customfield_10394";
const doi_field = "customfield_10396";
const depositor_name_field = "customfield_10398";
const curation_status_field = "customfield_10403";

// Functions

async function api_call(method, url, success_code, data) {
    let options = {
        method: method,
        headers: {
            Accept: "application/json",
            Authorization: "Basic " + auth
        }
    };
    if (data !== undefined) {
        options.headers["Content-Type"] = "application/json";
        options[payload_field] = data;
    }
    const r = await fetch_fn(base_url + url, options);
    if (status_fn(r) != success_code) {
        const t = await text_content_fn(r);
        throw new Error(`API call failed, status code ${status_fn(r)}, ${t}`);
    }
    return r;
}

function encode_query_string(params) {
    return (
        Object.keys(params)
        .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k]))
        .join("&")
    );
}

function check_defined(value) {
    if (value === undefined) {
        throw new Error("undefined value");
    }
    return value;
}

async function get_curation_issues() {
    let issues = [];
    let start = 0;
    while (true) {
        const query = encode_query_string(
            {
                jql: "project=RDS and issuetype=Curation",
                startAt: start.toString(),
                fields: ["status", doi_field].join(",")
            }
        );
        const r = await api_call("GET", "/search?" + query, 200);
        const j = JSON.parse(await text_content_fn(r));
        try {
            if (j.issues.length == 0) {
                break;
            }
            issues.push(...
                j.issues.map(i => {
                    return {
                        key: check_defined(i.key),
                        status: check_defined(i.fields.status.name),
                        doi: check_defined(i.fields[doi_field])
                    }
                })
            );
            start += j.issues.length;
        } catch (e) {
            throw new Error(
                `API unexpected response, ${e}, ${JSON.stringify(j)}`
            );
        }
    }
    return issues;
}

function text_to_adf_json(text) {
    // Convert text to Atlassian Document Format JSON.
    // https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
    const line_separator = "\u2028";
    const paragraphs = (
        text
        .replaceAll(line_separator, " \n")
        .split(paragraph_separator)
        .map(p => p.replaceAll("\n", "").trim())
        .filter(p => p.length > 0)
    );
    return {
        version: 1,
        type: "doc",
        content:
            paragraphs.map(p => {
                return {
                    type: "paragraph",
                    content: [
                        {
                            type: "text",
                            text: p
                        }
                    ]
                }
            })
    };
}

async function create_curation_issue(
    email_text,
    doi,
    dataset_name,
    depositor)
{
    let payload = {
        fields: {
            project: {
                key: "RDS"
            },
            issuetype: {
                name: "Curation"
            },
            summary: `Dryad curation doi:${doi}`,
            description: text_to_adf_json(email_text)
        }
    };
    payload.fields[dataset_name_field] = dataset_name;
    payload.fields[doi_field] = doi;
    payload.fields[depositor_name_field] = depositor;
    payload.fields[curation_status_field] = {
        value: "Submitted"
    };
    const r = await api_call("POST", "/issue", 201, JSON.stringify(payload));
    const j = JSON.parse(await text_content_fn(r));
    try {
        return check_defined(j.key);
    } catch (e) {
        throw new Error(`API unexpected response, ${e}, ${JSON.stringify(j)}`);
    }
}

function email_type(email_text) {
    // When running under Google Apps Script, the email "plain text"
    // is unhelpfully word-wrapped, so we anticipate spurious
    // newlines.
    const markers = {
        submission: "Your submission will soon enter our curation process.",
        publication: (
            "has been reviewed by our curation team and approved "
            + "for publication."
        ),
        peer_review: (
            "Your dataset will now remain private until your "
            + "related manuscript has been accepted."
        )
    };
    const text = email_text.replace(/\s+/g, " ");
    const matches = Object.keys(markers).filter(
        k => text.includes(markers[k])
    );
    if (matches.length != 1) {
        throw new Error(
            (matches.length == 0 ? "unrecognized" : "ambiguous")
            + " email message type"
        );
    }
    return matches[0];
}

function parse_submission_email(email_text) {
    // When running under Google Apps Script, the email "plain text"
    // is unhelpfully word-wrapped, so we anticipate spurious newlines
    // and weed them out.
    function extract(regexp) {
        return regexp.exec(email_text)[1].replaceAll("\n", "").trim();
    }
    const depositor = extract(/^Dear +([^ ].*),$/m);
    const dataset_name = extract(
        /^Thank you for submitting your dataset entitled, "(.*?)"\.$/ms
    );
    const doi = extract(
        RegExp(
            "^Your dataset has been assigned a unique digital object "
            + "identifier \\(DOI\\):\\s*doi:(10\\.[0-9]+/[0-9A-Z]+)",
            "m"
        )
    );
    return [doi, dataset_name, depositor];
}

async function change_issue_status(key, new_status) {
    // N.B.: Status changes must obey the transitions allowed by the
    // workflow set up in Jira.
    const r = await api_call("GET", `/issue/${key}/transitions`, 200);
    const j = JSON.parse(await text_content_fn(r));
    let t;
    try {
        t = j.transitions.find(t => {
            check_defined(t.id);
            return t.to.name == new_status;
        });
    } catch (e) {
        throw new Error(`API unexpected response, ${e}, ${JSON.stringify(j)}`);
    }
    if (t === undefined) {
        throw new Error("new status not found in allowable transitions");
    }
    const payload = {
        transition: {
            id: t.id
        }
    };
    await api_call(
        "POST",
        `/issue/${key}/transitions`,
        204,
        JSON.stringify(payload)
    );
}

async function change_issue_fields(key, updates) {
    // `updates` should map field names to new values.
    const payload = {
        fields: updates
    };
    await api_call("PUT", `/issue/${key}`, 204, JSON.stringify(payload));
}

async function process_email(email_text) {
    if (email_type(email_text) != "submission") {
        console.log("Disposition: not a submission email, ignoring");
        return;
    }
    const [doi, dataset_name, depositor] = parse_submission_email(email_text);
    // Well here's a bummer.  There seems to be no way to query Jira
    // using JQL to find a curation issue whose DOI field matches the
    // DOI in hand, because DOI is a custom field.  Thus we are forced
    // to download all curation issues.  Over time this will result in
    // quadratic behavior.
    const ci = (await get_curation_issues()).find(ci => ci.doi == doi);
    if (ci !== undefined) {
        if (ci.status == "Waiting on Peer Review") {
            console.log(
                "Disposition: issue already exists, is "
                + "Waiting on Peer Review, changing to To Do"
            );
            // Must follow allowed transitions.
            await change_issue_status(ci.key, "In Progress");
            await change_issue_status(ci.key, "To Do");
            let updates = {
                assignee: null,
            };
            updates[curation_status_field] = {
                value: "Submitted"
            };
            await change_issue_fields(ci.key, updates);
        } else {
            console.log("Disposition: issue already exists, ignoring");
        }
    } else {
        console.log("Disposition: creating new issue");
        const key = await create_curation_issue(
            email_text,
            doi,
            dataset_name,
            depositor
        );
        console.log(key);
    }
}

// Main Google Apps Script processing

async function main() {
    console.log(`===> ${Date()}`);
    const threads = GmailApp.search("from:no-reply-dryad@datadryad.org");
    for (t = 0; t < threads.length; ++t) {
        const messages = threads[t].getMessages();
        for (m = 0; m < messages.length; ++m) {
            console.log("EMAIL");
            console.log(`To: ${messages[m].getTo()}`);
            console.log(`Subject: ${messages[m].getSubject()}`);
            await process_email(messages[m].getPlainBody());
            messages[m].moveToTrash();
        }
    }
}

// Command line operation

async function command_line() {
    const filename = check_defined(process.argv[2]);
    const email_text = await readFile(filename, "UTF-8");
    await process_email(email_text);
}

if (using_nodejs) {
    command_line();
}

// Debugging/development aids

async function print_issue(key) {
    const r = await api_call("GET", `/issue/${key}`, 200);
    const j = JSON.parse(await text_content_fn(r));
    console.log(JSON.stringify(j));
}
