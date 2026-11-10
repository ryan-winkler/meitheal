# Meitheal setup

Meitheal keeps household tasks and routines in Home Assistant. Use **Today** to review work that is due.

## Add the repository

1. Open **Settings → Apps → Install app** in Home Assistant.
2. Open the menu.
3. Select **Repositories**.
4. Add `https://github.com/ryan-winkler/meitheal-ha-addon`.
5. Search for **Meitheal**.

In earlier versions of Home Assistant, the store is under **Settings → Add-ons → Add-on Store**.

If Meitheal is already installed, keep its current repository entry. Home Assistant may show a separate Meitheal entry for the new URL. Back up the existing App before moving to that entry.

## Install and open

The store can list Meitheal even when it cannot download the image. Check [install status](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1) before you start.

1. Select **Meitheal**.
2. Select **Install**.
3. When the installation finishes, select **Start**.
4. Select **Open web UI**.

If the Supervisor log shows `401` for the image, follow [the install issue](https://github.com/ryan-winkler/meitheal-ha-addon/issues/1).

## Check your setup

1. Open **Today** in Meitheal.
2. Find **Add a task** in **Overview**.
3. Enter **Replace the kitchen filter**.
4. Select **Add**.
5. Open **Work**.
6. Find the task under **Due Today**.

When you finish the job, mark the task complete.

## Connect your calendar or to-do list

Open **Settings → Integrations** in Meitheal. Choose the calendar or to-do list you want to connect. Check the sync direction before you turn on a calendar connection.

If you want to use Meitheal tasks in Home Assistant dashboards or automations, open **Settings → Devices & services** in Home Assistant. Set up the Meitheal integration if it appears under **Discovered**.

## Keep your data

Meitheal stores its database in the add-on data folder. Make a Home Assistant backup that includes Meitheal before you uninstall it or try another release channel. Check that the backup completed. Home Assistant stops Meitheal while it creates the backup.

## Get help

Use the [public issue tracker](https://github.com/ryan-winkler/meitheal-ha-addon/issues). Include your Meitheal version and the step where you got stuck.
