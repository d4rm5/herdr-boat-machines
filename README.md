# Boat machines for Herdr

Manage Boat sandboxes from a terminal pane in Herdr. Create or adopt a sandbox, connect it as a saved Herdr machine, stop it, resume it, fork it, recover it, change auto-stop, save a snapshot, or delete it.

The plugin uses Boat's REST API, Herdr's CLI, and OpenSSH. It does not require the Boat CLI, a provider SDK, npm packages, or a background plugin service.

## Install locally

You need Herdr 0.9.5 or later, Node.js 22 or later, `ssh`, and `ssh-keygen`. The manifest supports Linux and macOS. Verification for this release ran on Linux.

1. Link this directory.

   ```sh
   herdr plugin link "$PWD"
   ```

2. Start Herdr and open a workspace.

   ```sh
   herdr
   ```

3. From another terminal connected to the same Herdr session, open the manager.

   ```sh
   herdr plugin action invoke boat.machines.manage
   ```

   The **Boat machines** overlay lists the available commands. Enter a command name or its menu number. Enter `q` to close it.

4. Choose `setup` and paste a Boat API key at the hidden prompt. The plugin saves it in its private config directory. It does not import the Boat CLI's login credentials.

   The key needs permission to read and operate the sandboxes you manage, authorize SSH, and read or write saved snapshots. A key's scope still applies to adopted sandboxes. Use [Boat's API key documentation](https://docs.boat.dev/api-keys/scopes.md) to choose permissions.

5. Choose `create` or `adopt`. Initial connection runs `herdr machine add` in the terminal. Approve Herdr's remote installation if needed. Cancelling that approval leaves the Boat sandbox intact and reports its ID.

6. Select the saved machine in Herdr's sidebar to work there. After a resume, that connection starts its installed remote Herdr server. A headless `herdr --machine ...` API command does not start the server by itself.

Use the plugin on **Local**, where you want to save your machine profiles and SSH credentials. A plugin invoked on a remote Herdr server runs on that server, not on your laptop.

## Use the standalone command

Run the same manager outside Herdr.

```sh
node src/cli.mjs manage
node src/cli.mjs help
node src/cli.mjs help create
```

For scripted setup in Bash, read the key without putting it in shell history or process arguments.

```bash
read -rs -p 'Boat API key: ' BOAT_API_KEY
printf '\n'
printf '%s' "$BOAT_API_KEY" | node src/cli.mjs setup --key-stdin
unset BOAT_API_KEY
```

Setup stores the supplied key without contacting Boat. Use `list` to check access. An exported `BOAT_API_KEY` takes precedence over the saved key.

Create a sandbox with a two-hour auto-stop, or adopt an existing one.

```sh
node src/cli.mjs create --name build --size small --ttl 7200
node src/cli.mjs adopt bx_23456789
node src/cli.mjs list
```

Replace example IDs with the ID printed by Boat or the plugin. Use `info` for current provider details and retained deletion status. Secret-bearing desktop URLs are omitted from its output.

```sh
node src/cli.mjs info bx_23456789
node src/cli.mjs sync bx_23456789
node src/cli.mjs sync
```

Stop ends running programs. Zero-data-retention or disabled snapshots can make it erase the disk. Read Boat's retention policy before confirming. The plugin never force-stops after a failed snapshot.

```sh
node src/cli.mjs stop bx_23456789 --confirm bx_23456789
node src/cli.mjs resume bx_23456789 --size large
node src/cli.mjs fork bx_23456789 --name copy --size small
node src/cli.mjs recover bx_23456789
```

Create and fork default to a one-hour auto-stop. Resume keeps the existing policy unless you supply `--ttl` or `--no-auto-stop`. Changing the timer sets the remaining time from now, rather than adding it to the previous deadline.

```sh
node src/cli.mjs extend bx_23456789 --ttl 28800
node src/cli.mjs extend bx_23456789 --no-auto-stop
node src/cli.mjs rename bx_23456789 'Build sandbox'
```

`rename` changes the Boat name. It does not rename the existing Herdr sidebar label. Use `herdr machine rename <profile-id> --label 'Build sandbox'` to change that label independently.

Saving a snapshot can replace an existing saved snapshot with the same name. The plugin requires the exact name as confirmation for every save. A running sandbox's fork uses its latest completed snapshot, which may omit recent writes.

```sh
node src/cli.mjs snapshot bx_23456789 build-image --confirm build-image
node src/cli.mjs snapshots
node src/cli.mjs create --name next-build --from build-image
```

`forget` removes only this plugin's local profile, binding, and active SSH entry. It works without an API key. It does not stop the sandbox or its billing. A binding with an unresolved deletion operation cannot be forgotten until that operation is resolved.

```sh
node src/cli.mjs forget bx_23456789
```

Deletion is irreversible. It requires the exact sandbox ID, sends Boat's confirmation header, and waits for the deletion operation. The plugin retains its operation ID while deletion is pending. Independent saved snapshots remain independent of sandbox deletion.

```sh
node src/cli.mjs delete bx_23456789 --confirm bx_23456789
node src/cli.mjs deletion <operation-id>
```

## Configure credentials and storage

Herdr provides `HERDR_PLUGIN_CONFIG_DIR`, `HERDR_PLUGIN_STATE_DIR`, and `HERDR_BIN_PATH`. Standalone commands default to `$XDG_CONFIG_HOME/herdr/plugins/config/boat.machines` and `$XDG_STATE_HOME/herdr/plugins/boat.machines`. Unset XDG variables default to `~/.config` and `~/.local/state`.

Find Herdr's config directory with this command.

```sh
herdr plugin config-dir boat.machines
```

The optional `config.json` accepts `apiKey`, `apiUrl`, and `org`. A saved key requires mode `0600`. Setup writes those permissions automatically. `BOAT_API_KEY`, `BOAT_API_URL`, and `BOAT_ORG` override their saved values. Set `BOAT_ORG=personal` or an organization ID to pin the intended wallet instead of following Boat's active wallet.

The default API URL is `https://boat.dev/api/v1`. A different API origin requires an explicitly supplied key or a key saved for that origin. The plugin refuses to send a saved production key to an unrelated URL override. HTTP is allowed only for explicitly configured loopback verification.

Bindings record their API URL and organization. Restore their original scope before syncing or operating on them. Configured home, configuration, and state roots may use directory symlinks, including a dotfiles-managed Herdr directory. The plugin resolves those roots to real paths before accessing or creating its files. Files inside those roots, including credentials and private keys, still reject symlinks. Use local, user-owned storage and a local filesystem for mutation locks.

## Keep SSH and cloud state consistent

The first connection generates a dedicated Ed25519 key under the state directory. The plugin adds an Include at the top of `~/.ssh/config` and preserves the remaining user configuration. It writes aliases under `~/.ssh/herdr-boat/`. It refuses a symlinked SSH config rather than replacing its target.

Boat's authenticated SSH response supplies the endpoint and host key. Each refresh writes a new immutable pin file and atomically replaces the alias entry. Strict host checking stays enabled. The alias excludes global host-key databases, host-key commands, DNS trust, agent forwarding, and configured multiplexing. The plugin never disables verification to handle a changed address or key.

Stop and resume preserve the Boat ID and existing Herdr profile ID. Fork gets a different ID and profile. Labels do not establish ownership. The plugin checks the exact saved profile ID, target, and remote session before changing it.

When Boat accepts a stop as archiving, the plugin disables the owned profile before polling. If the following status request fails, it reports the error and leaves the profile disabled. A refused stop leaves an enabled profile unchanged.

Run `sync` after an external resume, external stop, or auto-stop. Refresh is explicit. There is no continuous background watcher. A missing cloud sandbox keeps a disabled local binding until you forget it or finish a tracked deletion. Old SSH generations and the shared key remain after forgetting a binding so existing readers are not given a different pin file.

If cloud creation succeeds but local setup fails, the plugin keeps the sandbox and reports its ID. Use `info`, then `sync` to repair the connection. It never deletes a cloud sandbox as rollback. If a create or fork response is lost before the plugin learns its ID, the outcome is uncertain. List Boat sandboxes and adopt the exact ID instead of blindly repeating the billable command. There are no automatic mutation retries.

## Verify changes

Run the behavioral suite and the separate CLI scenario.

```sh
npm test
npm run smoke
```

Both use temporary directories, a loopback Boat API, and an executable Herdr fixture. The smoke command launches the real plugin CLI and checks generated configuration with the installed OpenSSH client. Neither command contacts live Boat or changes your saved profiles.

The implementation was also exercised with real Herdr 0.9.5 and a local OpenSSH server. That check covered machine registration, pinned authentication, refusal without the pin, remote-server reachability, profile preservation, and local-only forget. It does not prove live Boat provisioning or resume behavior.

The declared manager action and pane were exercised in isolated Herdr. The menu recovered from a missing-key error, accepted an API key without terminal echo, and closed through both `q` and Ctrl+C.

Live Boat lifecycle verification remains open. The installed Boat CLI was signed out, and a read-only request using an existing legacy credential returned HTTP 500. No live Boat sandbox was created, stopped, or deleted during implementation.

## Upstream contracts

- [Herdr plugins](https://herdr.dev/docs/plugins/).
- [Herdr saved machines](https://herdr.dev/docs/connecting-machines/).
- [Boat concepts and retention](https://docs.boat.dev/concepts).
- [Boat API reference](https://docs.boat.dev/api/v1.md).
- [Boat SSH endpoint and host-key contract](https://docs.boat.dev/api/reference/agent/configure-sandbox-ssh-key.md).
