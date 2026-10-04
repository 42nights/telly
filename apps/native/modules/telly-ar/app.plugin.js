// Config plugin for the TellyAr module: the camera text that the medicine finder and the AR pin
// need. It adds no `arkit` device capability, so phones without AR still install the app and keep
// the finder without AR.
const { withInfoPlist } = require("expo/config-plugins");

module.exports = function withTellyAr(config) {
	return withInfoPlist(config, (plist) => {
		plist.modResults.NSCameraUsageDescription =
			"The medicine finder uses the camera to find a medicine box and to pin where it is in your room.";
		return plist;
	});
};
