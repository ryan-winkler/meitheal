---
type: Guide
title: "Mention someone in a comment"
description: "Send a private inbox item to another active Home Assistant member."
---

# Mention someone in a comment

Open the task in Meitheal through Home Assistant. In a new comment or an edit, type `@` and choose a person from the suggestions. Use the arrow keys and Enter, or select the name by touch. Use `#` to link a task in the same comment.

When the comment is saved, the person can open **Mention inbox** in Meitheal, follow the link to the comment, and mark it read or unread. The inbox keeps up to 1,000 mentions per person for 30 days. It shows current comments and clears withdrawn mentions. Editing other text keeps the existing read state. Removing and restoring a mention within retention brings back the same item. Deleting the comment or task removes the inbox item.

The inbox uses the current Home Assistant account. If access changes, reopen Meitheal through Home Assistant. Check the selected names if a comment cannot be saved. Keep the text in the editor when retrying so Meitheal can recognize the same submission for up to 48 hours. Mention delivery uses the in-app inbox. Comment visibility follows existing household task access. The inbox and people lookup are separate private surfaces.

## Verify a new release

In a disposable Home Assistant instance, sign in as three members. Mention one person from a comment and confirm only they can open the inbox item. Mark it read in one session and refresh a second session. Remove the mention, then add it again and check that the read state survived. Delete the comment and retry the exact original request after restarting the App. Revoke the recipient and verify that the old page, offline mode, and encoded private URLs do not expose the inbox.
