# Process Supervisor Rules

## Always

- Register only subprocesses created by Roadrunner.
- Check PID start-time before signaling a process.
- Clean only registered Roadrunner-owned subprocesses.
- Prefer process groups for provider subprocesses.

## Never

- Do not use `pgrep opencode` as a cleanup mechanism.
- Do not kill editor sessions or external agent processes.
