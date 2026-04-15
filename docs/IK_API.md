# Robot Arm — IK API Reference for Agents

Use this document to instruct your AI agent on how to control the arm via HTTP.

---

## Base URL

```
https://YOUR_SERVER_HOST
```

All write endpoints require the header:
```
x-api-token: YOUR_API_TOKEN
```

---

## Coordinate System

```
Origin = base rotation axis at ground level

        +Z (up)
        │
        │   +X (forward)
        │  /
        │ /
        └──────── +Y (right)

Units: millimeters (mm) and degrees (°)
```

| Axis | Direction | Safe working range |
|------|-----------|--------------------|
| X    | Forward   | 50 – 250 mm        |
| Y    | Right (+) / Left (−) | −200 – 200 mm |
| Z    | Up        | 30 – 260 mm        |
| pitch | Gripper tilt | −60 – 60 ° (0 = level) |

**Origin is at the base center at ground level, not the shoulder.**
The shoulder pivot is 77 mm above ground (H_BASE = 77 mm).

---

## Arm Geometry (for reachability estimation)

```
L1  = 90 mm   (shoulder → elbow)
L2  = 90 mm   (elbow → wrist)
L_END = 97 mm (wrist → gripper tip)
H_BASE = 77 mm (ground → shoulder pivot)
```

Maximum horizontal reach from base axis ≈ **270 mm** (all segments extended).
Minimum reach ≈ **17 mm** (fully folded, theoretical).
Practical working range: **X 60–220 mm**, **Z 30–220 mm**, **Y ±150 mm**.

The ESP32 performs the IK calculation. Your agent only needs to supply (x, y, z, pitch).

---

## Endpoints

### `POST /api/ik_move` — Move to XYZ position

Move the arm tip to a world coordinate. The ESP32 solves inverse kinematics automatically.

**Request:**
```json
{
  "x": 150,
  "y": 0,
  "z": 100,
  "pitch": 0
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| x | number | 150 | Forward distance from base axis (mm) |
| y | number | 0 | Right/left offset (mm, + = right) |
| z | number | 100 | Height above ground (mm) |
| pitch | number | 0 | Gripper pitch angle (°, 0 = level, − = down, + = up) |

**Response (200):**
```json
{ "status": "sent", "x": 150, "y": 0, "z": 100, "pitch": 0 }
```

**Response (503):** ESP32 not connected.

---

### `POST /api/gripper` — Open or close the gripper

```json
{ "angle": 0 }
```

| angle | Meaning |
|-------|---------|
| 0     | Fully open |
| 90    | Half open |
| 180   | Fully closed |

---

### `POST /api/home` — Return to home position

No body required. Moves all 6 joints to 90°.

```
POST /api/home
```

---

### `POST /api/servo` — Direct joint override

Set a specific joint servo angle (advanced, bypasses IK).

```json
{ "channel": 2, "angle": 45 }
```

| channel | Joint    |
|---------|----------|
| 0       | Base     |
| 1       | Shoulder |
| 2       | Elbow    |
| 3       | Wrist    |
| 4       | Wrist2   |
| 5       | Gripper  |

---

### `POST /api/sequence` — Run a move sequence

```json
{
  "moves": [
    { "type": "ik_move", "x": 150, "y": 60,  "z": 100, "waitMs": 600 },
    { "type": "ik_move", "x": 150, "y": -60, "z": 100, "waitMs": 600 }
  ],
  "loop": true
}
```

| Field | Description |
|-------|-------------|
| moves | Array of move commands, each with an optional `waitMs` delay (default 2000) |
| loop  | If true, repeat indefinitely |
| repeat | Number of times to repeat (default 1, ignored if loop=true) |

---

### `POST /api/sequence/stop` — Stop a running sequence

No body required.

---

### `POST /api/message` — Push chat message to browser

```json
{ "role": "assistant", "text": "Moving to pick position…" }
```

---

### `GET /api/state` — Read current arm state

No auth required.

**Response:**
```json
{
  "esp32Connected": true,
  "angles": [90, 90, 90, 90, 90, 90],
  "joints": {
    "base": 90,
    "shoulder": 90,
    "elbow": 90,
    "wrist": 90,
    "wrist2": 90,
    "gripper": 90
  }
}
```

---

## Pick and Place Pattern

Your agent should follow this sequence for reliable pick/place:

```
PICK from position (px, py, pz):
  1. Open gripper          POST /api/gripper  {"angle": 0}
  2. Move above object     POST /api/ik_move   {"x":px, "y":py, "z":pz+50, "pitch":-15}
  3. Descend to object     POST /api/ik_move   {"x":px, "y":py, "z":pz,    "pitch":-15}
  4. Close gripper         POST /api/gripper  {"angle": 180}
  5. Ascend                POST /api/ik_move   {"x":px, "y":py, "z":pz+50, "pitch":-15}

PLACE at position (dx, dy, dz):
  6. Move above target     POST /api/ik_move   {"x":dx, "y":dy, "z":dz+50, "pitch":-15}
  7. Descend to target     POST /api/ik_move   {"x":dx, "y":dy, "z":dz,    "pitch":-15}
  8. Open gripper          POST /api/gripper  {"angle": 0}
  9. Ascend                POST /api/ik_move   {"x":dx, "y":dy, "z":dz+50, "pitch":-15}
 10. Home                  POST /api/home
```

**Wait between moves:** The arm uses smooth interpolation at ~0.3°/ms.
For large moves allow 2–3 seconds. For gripper only allow 0.8 seconds.

---

## Example curl Commands

```bash
# Move to (180, 0, 120) level
curl -X POST https://YOUR_SERVER/api/ik_move \
  -H "x-api-token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"x":180,"y":0,"z":120,"pitch":0}'

# Open gripper
curl -X POST https://YOUR_SERVER/api/gripper \
  -H "x-api-token: YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"angle":0}'

# Go home
curl -X POST https://YOUR_SERVER/api/home \
  -H "x-api-token: YOUR_TOKEN"

# Read state
curl https://YOUR_SERVER/api/state
```

---

## Discord Commands (if Discord bot is enabled)

Post these in the configured Discord channel:

| Message | Action |
|---------|--------|
| `!move 150 0 100` | IK move to (x=150, y=0, z=100) |
| `!move 150 0 100 -15` | Same with pitch −15° |
| `!home` | All joints to 90° |
| `!open` | Open gripper |
| `!close` | Close gripper |
| `!state` | Print current joint angles |
| `{...json...}` | Send raw WebSocket command |

Your agent can post raw JSON directly:
```
{"type":"ik_move","x":150,"y":0,"z":100,"pitch":0}
```

---

## Error Handling

| HTTP | Meaning | Action |
|------|---------|--------|
| 200 | Command sent to arm | Optionally verify with GET /api/state |
| 401 | Invalid API token | Check x-api-token header |
| 400 | Missing required fields | Check request body |
| 503 | ESP32 not connected | Arm is offline — retry or alert |
