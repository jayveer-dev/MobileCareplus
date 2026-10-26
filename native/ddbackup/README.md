# ddbackup

`ddbackup.c` is `tools/idevicebackup2.c` from [libimobiledevice](https://libimobiledevice.org) 1.4.0,
licensed under the GNU Lesser General Public License 2.1 (see the notice at the top of the file).

Mobile Care Plus's change: an optional keep-list (`DDBACKUP_KEEP`) so only chosen files are written to disk;
everything else the iPhone sends is read and discarded ("light load"). See `ddbackup_keep()` and its
call in `mb2_handle_receive_files()`. It also frees the previous file's device path on each loop,
which the original leaked. `config.h` and `endianness.h` stand in for headers from libimobiledevice's
build tree so this file builds on its own.
