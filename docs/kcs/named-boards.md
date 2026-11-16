# Named Boards

Open **Boards** from the sidebar inside Home Assistant. **Household** takes you to the existing task workspace. Use **New Board** for work with its own members and workflow. Use **Hide from my sidebar** to change your shortcuts. You can reopen a hidden Board from **Your Boards**.

## People and ticket permissions

Board owners manage access from **Board settings**. Viewers can open the Board and read its tickets. Members can add and edit tickets and move them between the columns their permissions allow. Owners can manage access and set ticket restrictions for everyone or for a specific person. The last active owner must add another active owner before handing over access.

Completion restrictions apply when a ticket enters or leaves Done. Deletion restrictions apply to the ticket even when the person attempting the action created it. Reload the Board if the ticket changed while you were editing it.

## Send a task

A Board owner can create a named destination, choose a triage column, and select who may send to it. The sender uses **Send a task** from **Boards**. Choose the destination and enter a title and any details. If the owner configured a recipient, **Assign to the recipient** requests direct assignment. If the recipient loses access, the ticket still goes to triage.

Keep the same submission when retrying unchanged content after a timeout. A submission token remains valid for 24 hours. The sender can retrieve the same acknowledgement through a retry during that period, including after the owner closes intake. Initial limits are 20 outstanding submissions and 60 accepted tasks per sender in a rolling 24-hour period.

## Goals and backups

When a Goal is shared with an Area, each viewer sees progress based on their readable Projects. A Board member with direct access can also open its unshared Goals. For instance, a Home viewer sees Home progress on a Goal shared with Home. A viewer who can open both scopes sees contributions from both.

Use Home Assistant App backups for the full instance. See [Home Assistant backups and restore](./home-assistant-backup-and-restore.md) for the Board revision lock and rollback procedure.
