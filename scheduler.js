let interval = null;

function startScheduler() {
  // Stub - no scheduling
  interval = setInterval(() => {}, 60000);
}

function getStatus() {
  return {
    running: false,
    nextRun: null
  };
}

module.exports = {
  init: () => {},
  startScheduler,
  getStatus
};
