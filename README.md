# Dryad email processor

This is a bit of infrastructure code that processes automated
notification email messages received from
[Dryad](https://datadryad.org) and creates or updates issues in Jira.
The logic in a nutshell:

- Publication and private-for-peer-review notifications are ignored.

- Processing of a submission notification depends on whether there is
  already a Jira curation issue with a matching DOI or not.

  - If there is, the notification is ignored unless the Jira issue
    status is "Waiting on Peer Review," in which case the issue status
    is changed to "To Do," any assignee is removed, and the curation
    status is set to "Submitted."

  - If there is not, a new Jira issue is created.

- Processing of a withdrawal notification similarly depends on whether
  there is already an existing Jira issue or not.

  - If there is, and the Jira issue status is "Resolved," then the
    notification is ignored.  Otherwise, the issue status is set to
    "Resolved" with a disposition of "Won't Do," and the curation
    status is set to "Withdrawn."

  - If there is not, the notification is ignored.

`process-dryad-email.mjs` can be run under either of two platforms,
Node.js or Google Apps Script.  A few declarations at the top of the
script must be set to match the platform.  For either platform, the
`auth` variable must be set to an email address and Jira API token as
indicated, where the latter has been obtained from
[atlassian.com](https://atlassian.com).

Under Node.js, install `node-fetch` using `npm` and invoke from the
command line as:

```
node process-dryad-email.mjs message
```

The script filename must end in `.mjs` to enable the new
ECMAScript-style import statements.  `message` should be a Dryad email
message saved in plain text format.  The action taken is logged to
standard output.

Under Google Apps Script, the script processes all messages received
from `no-reply-dryad@datadryad.org` (that are in the project's owner's
Gmail account).  After processing, **all** such messages are moved to
the trash.

To install the script in Google Apps Script:

- Head to [script.google.com](https://script.google.com) and create a
  project.

- Paste the script code into the editor pane, and set the platform
  configuration and `auth` variable as noted above.

- Under Services, add the Gmail API.

- In the project settings pane, check the box that enables viewing
  `appsscript.json`.

- Back in the editor pane, edit `appsscript.json` to add two OAuth
  scopes, `https://www.googleapis.com/auth/gmail.modify` and
  `https://www.googleapis.com/auth/script.external_request`, as shown
  in the file in this distribution.

- View the script code again.  Select `main` as the function to run.

- Run the script.  An OAuth window will appear allowing you to grant
  the project the permissions required.

- The script can now be run at will.  Create a trigger to run
  periodically.  There does not appear to be a need to "deploy" the
  project as such.

`process-dryad-email.py`, unused, is equivalent code in Python.
