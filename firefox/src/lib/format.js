/* Shared export filename timestamp.
 *
 * Single source for the YYYYMMDD-HHMMSS stamp used by export filenames
 * (src/export-builder.js) and download filenames (src/message-router.js).
 * Local time, same as before — only the duplication is gone. Classic-script
 * globals — loaded via importScripts before its consumers.
 */
var AE = AE || {};
(function () {
  "use strict";

  AE.buildStamp = function (now) {
    var d = now instanceof Date ? now : new Date();
    function p(n) { return String(n).padStart(2, "0"); }
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  };
})();
