---
type: Guide
title: "Mention someone in a comment"
description: "Send a private inbox item to another active Home Assistant member."
---

# Mention someone in a comment

Open the task in Meitheal through Home Assistant. In a new comment or an edit, type `@` and choose a person from the suggestions. Use the arrow keys and Enter, or select the name by touch. Use `#` to link a task in the same comment.

When the comment is saved, the person can open **Mention inbox** in Meitheal, follow the link to the comment, and mark it read or unread. The inbox keeps up to 1,000 mentions per person for 30 days. It shows current comments and clears withdrawn mentions. Editing other text keeps the existing read state. Removing and restoring a mention within retention brings back the same item. Deleting the comment or task removes the inbox item.

The inbox uses the current Home Assistant account. It clears while the browser is offline and checks your session again when you reconnect. If the account changed while you were editing, copy your draft before reopening Meitheal under the account you started with. If you see a save error with the same account, leave the text in the editor and try again. Meitheal can recognize the same submission for up to 48 hours.

Mention delivery uses the in-app inbox. Comment visibility follows existing household task access. Meitheal hides the selected names in shared comment history if it cannot verify your Home Assistant membership. The inbox and people lookup are private to the active session.

Person suggestions send the typed search text in a bounded JSON request body. The lookup checks the current account and same-origin browser context before returning up to five suggestions.

## Verify a new release

In browser developer tools, check that typing a name sends a POST to the canonical `/api/comment-people` path, with the search text in the JSON body. Confirm the URL has no query and the response uses `private, no-store`. Other methods, URL filters and cross-origin requests should be denied.

In a disposable Home Assistant instance, sign in as three members. Start a mention, switch the sender's account in another tab, and verify the open editor keeps the draft without adding a comment or inbox item. Switch back and save the draft. Confirm only the recipient can open the item. Take their browser offline and check that the title clears immediately and returns only after reconnection. Mark the item read, remove and restore the mention, and check that the read state survives. Revoke the recipient and check that their retained session cannot load the inbox or see the mention name in shared comment history. Delete the comment and replay the original request after restarting the app, using the original account and a freshly opened editor context.
