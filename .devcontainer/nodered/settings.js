/**
 * Node-RED Settings — Meitheal Dev Environment
 *
 * Minimal config for integration testing. Auth disabled for dev.
 * The HA WebSocket palette is installed via devcontainer-setup.sh.
 */
module.exports = {
  uiPort: process.env.PORT || 1880,
  uiHost: "0.0.0.0",

  // Disable editor authentication for dev
  adminAuth: null,

  // Flow file location (inside Docker volume)
  userDir: "/data",
  flowFile: "flows.json",

  // Logging
  logging: {
    console: {
      level: "info",
      metrics: false,
      audit: false,
    },
  },

  // Function node global context
  functionGlobalContext: {},

  // Editor theme
  editorTheme: {
    projects: {
      enabled: false,
    },
    header: {
      title: "Meitheal Dev — Node-RED",
    },
  },
};
