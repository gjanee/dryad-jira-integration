#! /usr/bin/env python3

# Demonstration program that creates or updates a Jira issue from a
# dataset submission email message received from Dryad.  The logic is
# very specific here; this is in no way a generic program.
#
# Usage: process-dryad-email.py email_address:token message
#
# `email_address` and `token` are used for Jira authentication;
# `token` should be an API token obtained from atlassian.com.
# `message` should be the email message as plain text.
#
# Requires the `requests` library (python -m pip install requests).
#
# Jira API reference:
# https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/

import collections
import json
import re
import requests
import urllib.parse
import sys

base_url = "https://ucsb-atlas.atlassian.net/rest/api/3"
auth = None  # set below

dataset_name_field = "customfield_10394"
doi_field = "customfield_10396"
depositor_name_field = "customfield_10398"
curation_status_field = "customfield_10403"

def api_call(method, url, success_code, **kwargs):
    headers = {
        "Accept": "application/json"
    }
    if "data" in kwargs:
        headers["Content-Type"] = "application/json"
    r = requests.request(
        method,
        base_url + url,
        headers=headers,
        auth=auth,
        **kwargs
    )
    assert r.status_code == success_code, (
        f"API call failed, status code {r.status_code}, {r.text}"
    )
    return r

CurationIssue = collections.namedtuple("CurationIssue", "key status doi")

def get_curation_issues():
    # Return all existing curation issues as [CurationIssue, ...].
    issues = []
    start = 0
    while True:
        query = urllib.parse.urlencode(
            {
                "jql": "project=RDS and issuetype=Curation",
                "startAt": str(start),
                "fields": ",".join(["status", doi_field])
            }
        )
        r = api_call("GET", "/search?" + query, 200)
        try:
            j = r.json()
            if len(j["issues"]) == 0:
                break
            issues.extend(
                CurationIssue(
                    key=i["key"],
                    status=i["fields"]["status"]["name"],
                    doi=i["fields"][doi_field]
                )
                for i in j["issues"]
            )
            start += len(j["issues"])
        except:
            raise Exception(f"API unexpected response, {r.text}")
    return issues

def text_to_adf_json(text):
    # Convert text to Atlassian Document Format JSON.
    # https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
    line_separator = "\u2028"
    paragraphs = [
        p.strip()
        for p in re.split(r"\n+", text.replace(line_separator, "\n"))
        if len(p.strip()) > 0
    ]
    return {
        "version": 1,
        "type": "doc",
        "content": [
            {
                "type": "paragraph",
                "content": [
                    {
                        "type": "text",
                        "text": p
                    }
                ]
            }
            for p in paragraphs
        ]
    }

def create_curation_issue(email_text, doi, dataset_name, depositor):
    payload = json.dumps(
        {
            "fields": {
                "project": {
                    "key": "RDS"
                },
                "issuetype": {
                    "name": "Curation"
                },
                "summary": f"Dryad curation doi:{doi}",
                "description": text_to_adf_json(email_text),
                dataset_name_field: dataset_name,
                doi_field: doi,
                depositor_name_field: depositor,
                curation_status_field: {
                    "value": "Submitted"
                }
            }
        }
    )
    r = api_call("POST", "/issue", 201, data=payload)
    try:
        return r.json()["key"]
    except:
        assert False, f"API unexpected response, {r.text}"

def email_type(email_text):
    markers = {
        "submission": "Your submission will soon enter our curation process.",
        "publication": (
            "has been reviewed by our curation team and approved "
            + "for publication."
        ),
        "peer_review": (
            "you have selected to keep your Dryad data submission in "
            + "\"Private for peer review\" status"
        )
    }
    matches = [t for t, m in markers.items() if m in email_text]
    assert len(matches) >= 1, "unrecognized email message type"
    assert len(matches) == 1, "ambiguous email message type"
    return matches[0]

def parse_submission_email(email_text):
    depositor = re.search(
        r"^Dear +([^ ].*),$",
        email_text,
        re.M
    )[1].strip()
    dataset_name = re.search(
        r"^Thank you for submitting your dataset entitled, \"(.*)\"\.$",
        email_text,
        re.M
    )[1].strip()
    doi = re.search(
        r"^Your dataset has been assigned a unique digital object "
        + r"identifier \(DOI\): doi:(10\.[0-9]+/[0-9A-Z]+)",
        email_text,
        re.M
    )[1]
    return (doi, dataset_name, depositor)

def change_issue_status(key, new_status):
    # N.B.: Status changes must obey the transitions allowed by the
    # workflow set up in Jira.
    r = api_call("GET", f"/issue/{key}/transitions", 200)
    try:
        id = [
            t["id"]
            for t in r.json()["transitions"]
            if t["to"]["name"] == new_status
        ][0]
    except IndexError:
        raise Exception("new status not found in allowable transitions")
    except:
        raise Exception(f"API unexpected response, {r.text}")
    payload = json.dumps(
        {
            "transition": {
                "id": id
            }
        }
    )
    api_call("POST", f"/issue/{key}/transitions", 204, data=payload)

def change_issue_fields(key, **kwargs):
    # `kwargs` should map field names to new values.
    payload = json.dumps(
        {
            "fields": kwargs
        }
    )
    api_call("PUT", f"/issue/{key}", 204, data=payload)

def process_email(email_text):
    if email_type(email_text) != "submission":
        print("not a submission email, ignoring")
        return
    doi, dataset_name, depositor = parse_submission_email(email_text)
    # Well here's a bummer.  There seems to be no way to query Jira
    # using JQL to find a curation issue whose DOI field matches the
    # DOI in hand, because DOI is a custom field.  Thus we are forced
    # to download all curation issues.  Over time this will result in
    # quadratic behavior.
    ci_match = list(filter(lambda ci: ci.doi == doi, get_curation_issues()))
    if len(ci_match) > 0:
        ci = ci_match[0]
        if ci.status == "Waiting on Peer Review":
            print("issue already exists, is PPR, changing to To Do")
            # Must follow allowed transitions.
            change_issue_status(ci.key, "In Progress")
            change_issue_status(ci.key, "To Do")
            updates = {
                "assignee": None,
                curation_status_field: {
                    "value": "Submitted"
                }
            }
            change_issue_fields(ci.key, **updates)
        else:
            print("issue already exists, ignoring")
    else:
        print("creating new issue")
        key = create_curation_issue(email_text, doi, dataset_name, depositor)
        print(key)

# Processing

auth = requests.auth.HTTPBasicAuth(*sys.argv[1].split(":", 1))
process_email(open(sys.argv[2]).read())

# Debugging/development aids

def print_issue(key):
    r = api_call("GET", f"/issue/{key}", 200)
    print(json.dumps(r.json(), indent=4))
