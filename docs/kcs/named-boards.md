---
type: "Guide"
title: "Named Boards"
description: "Set up private Boards, send-only access and scoped planning."
---

# Named Boards

Open **Boards** from the sidebar inside Home Assistant. **Household** takes you to the existing task workspace. Use **New Board** for work with its own members and workflow. Use **Hide from my sidebar** to change your shortcuts. You can reopen a hidden Board from **Your Boards**.

## People and ticket permissions

Board owners manage access from **Board settings**. Viewers can open the Board and read its tickets. Members can add and edit tickets and move them between the columns their permissions allow. Owners can manage access and set ticket restrictions for everyone or for a specific person. The last active owner must add another active owner before handing over access.

Completion restrictions apply when a ticket enters or leaves Done. Deletion restrictions apply to the ticket even when the person attempting the action created it. Reload the Board if the ticket changed while you were editing it.

## Send a task

A Board owner can create a named destination, choose a triage column, and select who may send to it. The sender uses **Send a task** from **Boards**. Choose the destination and enter a title and any details. If the owner configured a recipient, **Assign to the recipient** requests direct assignment. If the recipient loses access, the ticket still goes to triage.

Keep the same submission when retrying unchanged content after a timeout. A submission token remains valid for 24 hours. The sender can retrieve the same acknowledgement through a retry during that period, including after the owner closes intake. Initial limits are 20 outstanding submissions and 60 accepted tasks per sender in a rolling 24-hour period.

## Groups, Projects, Goals, Routines, and Pillars

Open **Groups** on a named Board and create a Group for related Projects, Goals and Routines. Choose an optional Goal when creating a Project, and use the Project status to track completion. Board owners manage planning, retire records and link Projects to Goals. Board Pillars can have Principles and links to the same Board’s Goals, Routines and tickets. Readers need Board access and availability of the corresponding feature. Remove a Group’s active Projects, Goals and Routines before removing the Group. Create a Pillar for yourself under **Progress → Pillars → New Pillar → Only me**.

Sharing a Goal with a Group publishes its title and a Project progress summary to readers of the receiving Group’s Board. Each viewer sees progress from Projects on Boards they can access. If a Project belongs to Work, its progress is omitted for Home readers who lack Work access. Select **Goal sharing → Stop sharing** to remove the shared view. A person with access through the Goal’s own Board can still read it.

Removing a Household Group, Goal or Project hides it from planning and keeps historical relationships intact. Existing Household tasks are unassigned from a removed Project. Named tickets and their versions stay intact.

A Board Routine is completed at most once per UTC day or week starting Monday. Completing it creates a Done ticket on the same Board and requires permission to create and complete tickets. Routine tickets remain on the Board to preserve completion history.

Open a Project’s settings and create a Routine in that context to keep its generated tickets in the same Group and Project. A completed, archived or removed Project prevents new occurrences. A retry for an already completed occurrence returns the same ticket while the caller still has the required Board permissions.

**Routines on your Boards** appears in the Routine library and Today for current Home Assistant members with readable named Boards. Choose **Mark done** to check in. Each row names its Board and frequency and shows **Done** after confirmation. Viewers can read the list. Completion controls follow the Board’s permissions and the Project’s status. The list shows up to 100 Routines; open the Board for the rest.

## Backups

Use Home Assistant App backups for the full instance. See [Home Assistant backups and restore](./home-assistant-backup-and-restore.md) for the Board revision lock and rollback procedure.

Sender submissions are available on Boards under Recent submissions for up to 24 hours. If a connection drops, retry the original submission there. Accepted submissions remain marked Sent if an owner closes the destination. Board owners can close or reopen destinations in Board settings.

To give an agent access, an administrator issues a scoped token and shares its ID with the Board owner. Add the ID under Board settings → Agent access. The agent needs an explicit Board grant and the scope for each ticket operation. Block deletion by agents applies even if a granted token has task deletion scope. Remove the grant from Board settings or revoke the token in Settings → Agent Tokens.

## Organize work within a Board

Open **Boards** and select **Household** or a named Board. The Board opens its tasks. Open **Groups** to manage ongoing responsibilities such as Kitchen or Operations. A group can contain standalone tasks and Projects. Open a Project to see its tasks and add work in that context. Quick capture from an unfiltered Board can leave a task Unfiled.

Expand a named Board from the sidebar to open one of its groups. Household's group shortcuts still include the existing Project pins and planning actions. The original Area and Project links continue to open existing work.

A named Board member with task edit access can open **File task**, choose a group or Project in that Board and save. It keeps the ticket and workflow column. If the destination or task has changed, refresh the Board before retrying. Owner settings and send-only access continue to use the existing Board rules.

With task edit access, set **Shared due date** when you add a task, or select an existing task’s title to open its edit form. Clear the field and choose **Save changes** to remove the date. People who can read the task can see its due date. A generated Routine ticket keeps the date of its original occurrence and shows it as **Scheduled for** in the edit form.

## Personal names, feature availability and physical location

Use **Settings → Navigation & Shortcuts → Labels** to give organizing features your own singular and plural names. The choices belong to your verified Home Assistant account and display language. Search accepts the default terms and your names. Record names and saved links keep their existing identities.

An administrator uses **Settings → Tasks & Boards → Organization features** to choose **Everyone**, **Selected people**, or **Nobody** for Boards organizer, Groups, Projects, Planning, Goals, Routines, Pillars, Principles, Achievements and Home Assistant Area. Board membership and permissions govern work on a named Board. The feature audience controls which organizing modules a person can use. See [Settings troubleshooting](settings-troubleshooting.md#choose-who-can-use-organization-features).

The optional **Home Assistant Area** field identifies a task’s physical location, such as Kitchen. Groups organize responsibility and Projects organize related tasks. An administrator can offer the location field through Organization features without changing the task’s Board, Group or Project.

Older `/areas/{id}` and `/projects/{id}` bookmarks open the matching Household Board context. Supported section bookmarks, including settings, keep their destination. `/planning#spaces` opens the Boards directory when Planning is available. Task filters use the Group label and support your personal display name from Settings.
