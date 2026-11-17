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

## Areas, Projects, Goals, Routines, and Pillars

Under **Planning** on a named Board, create an Area to group Projects, Goals and Routines. Choose an optional Goal when creating a Project, and use the Project status to track completion. Board owners manage planning, retire records and link Projects to Goals. Board Pillars can have Principles and links to the same Board’s Goals, Routines and tickets. People with Board access can read them. Remove an Area’s active Projects, Goals and Routines before removing the Area. Create a Pillar for yourself under **Progress → Pillars → New Pillar → Only me**.

Sharing a Goal with an Area publishes its title and a Project progress summary to people who can read that Area. Each viewer sees progress from Projects they can access. If a Project is private to Work, its progress is omitted for Home readers. Select **Goal sharing → Stop sharing** to remove the Area audience. The visitor can still see a Goal they already have direct access to.

Removing a Household Area, Goal or Project hides it from planning and keeps historical relationships intact. Existing Household tasks are unassigned from a removed Project. Named tickets and their versions stay intact.

A Board Routine is completed at most once per UTC day or week starting Monday. Completing it creates a Done ticket on the same Board and requires permission to mark tickets done. Routine tickets remain on the Board to preserve completion history.

## Backups

Use Home Assistant App backups for the full instance. See [Home Assistant backups and restore](./home-assistant-backup-and-restore.md) for the Board revision lock and rollback procedure.

Sender submissions are available on Boards under Recent submissions for up to 24 hours. If a connection drops, retry the original submission there. Accepted submissions remain marked Sent if an owner closes the destination. Board owners can close or reopen destinations in Board settings.

To give an agent access, an administrator issues a scoped token and shares its ID with the Board owner. Add the ID under Board settings → Agent access. The agent needs an explicit Board grant and the scope for each ticket operation. Block deletion by agents applies even if a granted token has task deletion scope. Remove the grant from Board settings or revoke the token in Settings → Agent Tokens.

## Organize work within a Board

Open **Boards** and select **Household** or a named Board. The Board opens its tasks. Open **Groups** to manage ongoing responsibilities such as Kitchen or Operations. A group can contain standalone tasks and Projects. Open a Project to see its tasks and add work in that context. Quick capture from an unfiltered Board can leave a task Unfiled.

Expand a named Board from the sidebar to open one of its groups. Household's group shortcuts still include the existing Project pins and planning actions. The original Area and Project links continue to open existing work.

A named Board member with task edit access can open **File task**, choose a group or Project in that Board and save. It keeps the ticket and workflow column. If the destination or task has changed, refresh the Board before retrying. Owner settings and send-only access continue to use the existing Board rules.
