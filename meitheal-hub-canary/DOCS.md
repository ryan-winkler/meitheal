# Meitheal Canary

Meitheal Canary is an experimental add-on for testing changes. Use sample tasks on a test installation. Keep daily household tasks in Meitheal Stable.

## Test a build

1. Add the [Meitheal add-on repository](https://github.com/Coolock-Village/meitheal-ha-addon) in Home Assistant.
2. Search for **Meitheal Canary** in the store.
3. When the image is available, select **Install**.
4. Select **Start**.
5. Select **Open web UI**.
6. Create a sample task.
7. Refresh the page.
8. Check that the task is still there.

## Keep stable data separate

Stable and Canary have separate add-on identities and data folders. Treat a channel change as a separate installation. Before you uninstall either add-on, make a backup that includes it.

## Report what you found

Include the Canary version shown in the store. Describe the steps you took, what you expected, and what happened. Remove private data from logs and screenshots. [Report an issue](https://github.com/Coolock-Village/meitheal-ha-addon/issues).
