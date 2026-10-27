// Minimal stand-in for Adobe's CSInterface.js, so nothing has to be downloaded.
// CEP injects window.__adobe_cep__; these two calls are all the panel needs.
function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  window.__adobe_cep__.evalScript(script, callback || function () {});
};

CSInterface.prototype.getHostEnvironment = function () {
  return JSON.parse(window.__adobe_cep__.getHostEnvironment());
};
