---
type: "Guide"
title: "Named Boards"
description: "Set up private Boards, send-only access and scoped planning."
---

# Named Boards

Open **Boards** from the sidebar inside Home Assistant. **Household** takes you to the existing task workspace. Use **New Board** for work with its own members and workflow. Use **Hide from my sidebar** to change your shortcuts. You can reopen a hidden Board from **Your Boards**.

Expand **Boards** to find Household and your other visible Boards. Expand a Board to see its Areas and an Area to see its Projects. **Show more Projects** preserves the choices already loaded while it checks the next page. If that check fails, retry the same page. Keyboard focus moves to the first new choice only when you remain on the paging control. Losing access clears private shortcuts. The **All Areas** picker filters the selected Board. Project selection keeps its own context.

Household and named Boards use the same Kanban cards and columns. Select a named Board card to open its details, or focus it and press Enter. You can edit, file, move or remove the ticket when your permissions allow it. Changes use the ticket version, so a concurrent edit requires refreshing before trying again. Creation opens the same detail panel. The named workspace exposes Kanban, and Household also provides Table, Calendar and Timeline.

Open an Area or Project’s **Tasks** link to use its filtered Kanban. Local planning tabs keep you in the current Area or Project. On a phone, the links wrap so **Settings** remains reachable, including with longer personal names. **Add Task** keeps that context. On a named Board, **N** opens capture for that Board. If another person changes its work while you edit, your input stays available with a refresh notice. Lost authority and deleted context clear private content. Backgrounding and temporary connectivity failures hide it while keeping the current draft on that page for revalidation.

An older Project without a direct Area assignment does not inherit your last Area filter. Its capture keeps the Project and uses its existing default filing.

If Board verification temporarily fails, the workspace hides its private content and offers **Retry verification**. A successful check restores the same page and retained input. Permanent loss of access clears it and offers a fresh Board view.

## People and ticket permissions

Board owners manage access from **Board settings**. Viewers can open the Board and read its tickets. Members can add and edit tickets and move them between the columns their permissions allow. Owners can manage access and set ticket restrictions for everyone or for a specific person. The last active owner must add another active owner before handing over access.

Completion restrictions apply when a ticket enters or leaves Done. Deletion restrictions apply to the ticket even when the person attempting the action created it. Reload the Board if the ticket changed while you were editing it.

## Send a task

A Board owner can create a named destination, choose a triage column, and select who may send to it. The sender uses **Send a task** from **Boards**. Choose the destination and enter a title and any details. If the owner configured a recipient, **Assign to the recipient** requests direct assignment. If the recipient loses access, the ticket still goes to triage.

Keep the same submission when retrying unchanged content after a timeout. A submission token remains valid for 24 hours. The sender can retrieve the same acknowledgement through a retry during that period, including after the owner closes intake. Initial limits are 20 outstanding submissions and 60 accepted tasks per sender in a rolling 24-hour period.

## Areas, Projects, Goals, Routines, and Pillars

Open **Areas** on a named Board and create an Area for related Projects, Goals and Routines. Choose an optional Goal when creating a Project, and use the Project status to track completion. Board owners manage planning, retire records and link Projects to Goals. Board Pillars can have Principles and links to the same Board’s Goals, Routines and tickets. Readers need Board access and availability of the corresponding feature. Remove an Area’s active Projects, Goals and Routines before removing the Area. Create a Pillar for yourself under **Progress → Pillars → New Pillar → Only me**.

Sharing a Goal with an Area publishes its title and a Project progress summary to readers of the receiving Area’s Board. Each viewer sees progress from Projects on Boards they can access. If a Project belongs to Work, its progress is omitted for Home readers who lack Work access. Select **Goal sharing → Stop sharing** to remove the shared view. A person with access through the Goal’s own Board can still read it.

Removing a Household Area, Goal or Project hides it from planning and keeps historical relationships intact. Existing Household tasks are unassigned from a removed Project. Named tickets and their versions stay intact.

A Board Routine is completed at most once per UTC day or week starting Monday. Completing it creates a Done ticket on the same Board and requires permission to create and complete tickets. Routine tickets remain on the Board to preserve completion history.

Open a Project’s settings and create a Routine in that context to keep its generated tickets in the same Area and Project. A completed, archived or removed Project prevents new occurrences. A retry for an already completed occurrence returns the same ticket while the caller still has the required Board permissions.

**Routines on your Boards** appears in the Routine library and Today for current Home Assistant members with readable named Boards. Choose **Mark done** to check in. Each row names its Board and frequency and shows **Done** after confirmation. Viewers can read the list. Completion controls follow the Board’s permissions and the Project’s status. The list shows up to 100 Routines; open the Board for the rest.

## Backups

Use Home Assistant App backups for the full instance. See [Home Assistant backups and restore](./home-assistant-backup-and-restore.md) for the Board revision lock and rollback procedure.

Sender submissions are available on Boards under Recent submissions for up to 24 hours. If a connection drops, retry the original submission there. Accepted submissions remain marked Sent if an owner closes the destination. Board owners can close or reopen destinations in Board settings.

To give an agent access, an administrator issues a scoped token and shares its ID with the Board owner. Add the ID under Board settings → Agent access. The agent needs an explicit Board grant and the scope for each ticket operation. Block deletion by agents applies even if a granted token has task deletion scope. Remove the grant from Board settings or revoke the token in Settings → Agent Tokens.

## Organize work within a Board

Open **Boards** and select **Household** or a named Board. The Board opens its tasks. Open **Areas** to manage ongoing responsibilities such as Kitchen or Operations. An Area can contain standalone tasks and Projects. Open a Project to see its tasks and add work in that context. Quick capture from an unfiltered Board can leave a task Unfiled.

Expand a Board from the sidebar to open one of its Areas. Household's Area shortcuts include the existing Project pins and planning actions. The original Area and Project links continue to open existing work.

A named Board member with task edit access can open **File task**, choose an Area or Project in that Board and save. It keeps the ticket and workflow column. If the destination or task has changed, refresh the Board before retrying. Owner settings and send-only access continue to use the existing Board rules.

With task edit access, set **Shared due date** when you add a task, or select an existing task’s title to open its edit form. Clear the field and choose **Save changes** to remove the date. People who can read the task can see its due date. A generated Routine ticket keeps the date of its original occurrence and shows it as **Scheduled for** in the edit form.

## Personal names, feature availability and physical location

Use **Settings → Navigation & Shortcuts → Labels** to give organizing features your own singular and plural names. The choices belong to your verified Home Assistant account and display language. Search accepts the default terms and your names. Record names and saved links keep their existing identities.

An administrator uses **Settings → Tasks & Boards → Organization features** to choose **Everyone**, **Selected people**, or **Nobody** for Boards organizer, Areas, Projects, Planning, Goals, Routines, Pillars, Principles, Achievements and Home Assistant Area. Board membership and permissions govern work on a named Board. The feature audience controls which organizing modules a person can use. Areas and Projects also require the Boards organizer; independent Goal and Routine libraries keep their own availability. See [Settings troubleshooting](settings-troubleshooting.md#choose-who-can-use-organization-features).

When Areas is unavailable to you, an unfiltered Board remains accessible with its existing permissions. Timeline filters can save an empty `area=` for **All Areas**; reloading that link keeps the unfiltered workspace available. A link to a specific Area still requires Areas availability.

The optional **Home Assistant Area** field identifies a task’s physical location, such as Kitchen. Areas organize responsibility and Projects organize related tasks. An administrator can offer the location field through Organization features without changing the task’s Board, Area or Project.

Older `/areas/{id}` and `/projects/{id}` bookmarks open the matching Household Board context. Supported section bookmarks, including settings, keep their destination. `/planning#spaces` opens the Boards directory when Planning is available. Task filters use the Area label and support your personal display name from Settings.

Household Project details use Tabler icons for their tabs and actions. The title and breadcrumb show Tabler equivalents for recognized icons, including the Every Day sun. Custom icons without an equivalent still display as entered. Open **Settings** to see the saved Project icon.

Home Assistant Area participates in the task inspector’s reorderable Properties fields. Move it in the ticket layout editor or Settings. Existing saved field orders retain their sequence and add the new field.

## Delete and restore a Board

Open a named Board’s **Board settings → Delete Board**. An owner with deletion permission can delete either an empty or populated Board. Review its name in the **Delete Board** dialog. **Cancel** receives initial focus and returns you to the delete control without changing the Board. The destructive confirmation also says **Delete Board**. The Board leaves active navigation, incoming destinations and Routine check-ins. Its tickets, filing, membership, permissions and ticket numbers stay saved. **Boards → Deleted Boards → Restore Board** resumes it. Each restore control includes its Board name for assistive technology. Only its eligible owners can see this recovery list; other users and agents cannot restore or delete the Board.

For **Household**, a verified Home Assistant administrator uses **Boards → Household Board settings → Delete Board**. Household’s saved work stays in place. Shared capture, Household task screens, Routine generation, calendar import/write-back and Todo syncing pause until an administrator restores it from Deleted Boards. No replacement Board is created and no records are transferred. Named Boards remain available. Global views exclude the saved Household work while it is deleted. Restoring resumes its existing destinations and settings, so review those settings before restoring an old integration configuration.

A synchronization request already sent to Home Assistant may finish there after deletion. Later local writes pause and preserve the saved links. Deletion does not cancel a provider request already in flight.

Task-driven Calendar and Todo calls recheck Household before dispatch. A Calendar update that fails after retirement cannot start its delete/create fallback. Other Home Assistant service callers keep their existing behavior.

The Routine library and Today continue to show Routines from your active named Boards. Household Routines and shared creation stay paused. Calendar and Todo confirmation links remain saved for restoration.

Deletion restrictions also apply to Board deletion. A child with deletion blocked cannot remove their Board; blocking completion still blocks marking work done and reopening it. Agent tokens cannot delete or restore Boards. Sidebar hiding remains a personal shortcut choice and does not delete a Board.

If the Board changed, refresh before trying again. If access publication is still being verified, the change is saved: refresh Boards to check the result before retrying. Offline or failed requests keep the form available. A network interruption may have happened after the save; reload Boards to establish the saved state.
