// from: https://dev.to/li/how-to-requestpermission-for-devicemotion-and-deviceorientation-events-in-ios-13-46g2
function requestOrientation() {
  // Motion sensors only work on secure (https://) pages
  if (!window.isSecureContext) {
    alert("This page must be opened with https:// for the tilt sensors to work.");
    return;
  }
  if (typeof DeviceOrientationEvent === "undefined") {
    alert("This browser has no motion sensors. Try Safari on iPhone or Chrome on Android.");
    return;
  }

  // iOS 13+ asks for permission first
  if (typeof DeviceOrientationEvent.requestPermission === "function") {
    DeviceOrientationEvent.requestPermission()
      .then((permissionState) => {
        if (permissionState === "granted") {
          window.addEventListener("deviceorientation", handleOrientation, true);
        } else {
          alert("Motion access was denied. Reload the page and tap Allow to play.");
        }
      })
      .catch((err) => {
        console.error(err);
        alert("Could not ask for motion access. Reload the page and try again.");
      });
  } else {
    // regular non-iOS-13 devices (e.g. Android): no permission step
    window.addEventListener("deviceorientation", handleOrientation, true);
  }
}
// node server.js
// add local host with https in browser
