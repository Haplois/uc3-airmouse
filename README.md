# Remote 3 airmouse

The airmouse runtime lives on the Remote 3. This repository also contains a
local tool that retrieves the rotating Web Config PIN through existing SSH root
access. The PIN tool does not install or run anything on the remote.

## Retrieve the Web Config PIN

Run the .NET tool from the repository root:

```sh
tools/uc3-pin
```

The command prints the four-digit PIN to standard output. It reads the
`web-configurator` Argon2id password hash from Remote Core's SQLite database over
SSH, searches the 10,000 possible PINs locally, and verifies the result against
the Remote 3 Web Config API.

To test access without printing the PIN:

```sh
tools/uc3-pin --verify-only
```

Use `--workers N` to limit local Argon2 work. The default is the smaller of the
processor count and 16. The accepted range is 1 through 32.

## Development checks

```sh
tools/uc3-pin --self-test
dotnet build Uc3Airmouse.slnx --no-restore
```
