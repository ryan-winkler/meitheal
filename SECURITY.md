# Security policy

## Report privately

Email [the maintainer](mailto:info@coolockvillage.ie) with the subject **Meitheal security report**. Use a test installation and sample data.

Include the Meitheal version, install type, and steps to reproduce the problem. Explain which account or access level the steps need. Describe the data or action that the problem exposes.

Keep the report out of public issues and discussions. Remove access tokens, passwords, and household data. If you need to share sensitive evidence, ask the maintainer for a private transfer method.

## What to report

Report a problem that lets someone read or change data, act with more access than intended, or make the app unavailable. These boundaries matter in Meitheal.

- Pages and endpoints that expose household data or make changes must check the caller’s access.
- Forwarded identity must come from the trusted Home Assistant route.
- Tokens must grant access only to the operations allowed by their scope.
- Imports, task content, webhook destinations, and integration responses can contain untrusted input.
- Logs, backups, exports, and browser storage can contain household data. Report unintended access or disclosure.

Report what you observed and which version it affects. For a fault in a dependency, describe how the fault can be reached through Meitheal.

## After you report

The maintainer may ask for a shorter reproduction or more version details. Coordinate disclosure by email so that users can update or take protective action.
