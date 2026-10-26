/*
 * ddicons: saves home-screen icons of iPhone apps as PNG files, over USB, using the
 * phone's springboard service (no network). One connection for all apps.
 *
 *   ddicons <udid> <output-dir> <bundle-id>...
 *
 * Writes <output-dir>/<bundle-id>.png and prints "ok <bundle-id>" or "fail <bundle-id>" per app.
 * Exit code 1 when the phone or its service can't be reached.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <libimobiledevice/libimobiledevice.h>
#include <libimobiledevice/sbservices.h>

/* Bundle ids are reverse-DNS; refuse anything that could leave the output folder. */
static int safe_id(const char *id) {
	if (!*id || strstr(id, "..")) return 0;
	for (const char *c = id; *c; c++)
		if (!((*c >= 'a' && *c <= 'z') || (*c >= 'A' && *c <= 'Z') || (*c >= '0' && *c <= '9') || *c == '.' || *c == '-' || *c == '_')) return 0;
	return 1;
}

int main(int argc, char **argv) {
	if (argc < 4) {
		fprintf(stderr, "usage: ddicons <udid> <output-dir> <bundle-id>...\n");
		return 2;
	}
	idevice_t device = NULL;
	if (idevice_new_with_options(&device, argv[1], IDEVICE_LOOKUP_USBMUX) != IDEVICE_E_SUCCESS) {
		fprintf(stderr, "ERROR: Device %s not found\n", argv[1]);
		return 1;
	}
	sbservices_client_t sb = NULL;
	if (sbservices_client_start_service(device, &sb, "ddicons") != SBSERVICES_E_SUCCESS) {
		fprintf(stderr, "ERROR: Could not start the springboard service\n");
		idevice_free(device);
		return 1;
	}
	for (int i = 3; i < argc; i++) {
		const char *id = argv[i];
		char *png = NULL;
		uint64_t size = 0;
		int ok = 0;
		if (safe_id(id) && sbservices_get_icon_pngdata(sb, id, &png, &size) == SBSERVICES_E_SUCCESS && png && size > 0) {
			char path[4096];
			snprintf(path, sizeof path, "%s/%s.png", argv[2], id);
			FILE *f = fopen(path, "wb");
			if (f) {
				ok = fwrite(png, 1, (size_t)size, f) == size;
				fclose(f);
			}
		}
		free(png);
		printf("%s %s\n", ok ? "ok" : "fail", id);
		fflush(stdout);
	}
	sbservices_client_free(sb);
	idevice_free(device);
	return 0;
}
