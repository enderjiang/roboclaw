/*
 * esp32_cloud_client.ino  —  ESP32 WebSocket CLIENT for cloud relay
 * ==================================================================
 * Instead of hosting its own AP + HTTP server, this firmware:
 *   1. Connects to your existing WiFi hotspot (STA mode)
 *   2. Connects OUT to your cloud relay server as a WebSocket client
 *   3. Receives commands (ik_move / move / move_all / get_state)
 *   4. Executes them and sends state back
 *
 * The cloud relay server then bridges the ESP32 to:
 *   - Your REST API (for your agent)
 *   - The browser control panel
 *   - Discord (optional)
 *
 * Hardware : ESP32 + PCA9685  (I2C SDA=1 SCL=2, addr=0x40)
 *
 * Required libraries (install via Arduino Library Manager):
 *   - ArduinoWebsockets  (by Gil Maimon)  OR  WebSockets (by Markus Sattler)
 *   - ArduinoJson        (by Benoit Blanchon)
 *   - Adafruit PWM Servo Driver Library
 *
 * ── USER CONFIG ── fill in the 4 lines below ────────────────────────
 */

// ── WiFi (your hotspot, NOT "robot" AP) ──────────────────────────────
const char* WIFI_SSID  = "YourSSID";
const char* WIFI_PASS  = "YourPassword";

// ── Cloud relay server ───────────────────────────────────────────────
// For Railway / Render (HTTPS): set SSL=true, PORT=443
// For local testing:            set SSL=false, HOST="192.168.x.x", PORT=3000
const char*    SERVER_HOST = "your-app.up.railway.app"; // hostname only, no https://
const uint16_t SERVER_PORT = 443;
const char*    SERVER_PATH = "/ws/esp32";
const bool     SERVER_SSL  = true;

// ── END USER CONFIG ──────────────────────────────────────────────────

#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <math.h>

// ── PCA9685 ───────────────────────────────────────────────────────────
#define I2C_SDA       1
#define I2C_SCL       2
#define PCA9685_ADDR  0x40
#define NUM_SERVOS    6
#define SERVO_MIN_US  500
#define SERVO_MAX_US  2500

#define J_BASE     0
#define J_SHOULDER 1
#define J_ELBOW    2
#define J_WRIST    3
#define J_WRIST2   4
#define J_GRIPPER  5

int servoChannels[NUM_SERVOS] = {0, 1, 2, 3, 4, 5};

float currentAnglesF[NUM_SERVOS] = {90,90,90,90,90,90};
float targetAngles[NUM_SERVOS]   = {90,90,90,90,90,90};
#define MOVE_SPEED_DEG_MS  0.30f

const float SERVO_LIMITS[NUM_SERVOS][2] = {
    {  0, 180 },  // Base
    {  0, 180 },  // Shoulder
    {  0, 180 },  // Elbow
    {  2, 178 },  // Wrist
    {  2, 178 },  // Wrist2
    {  0, 180 },  // Gripper
};

// ── Arm kinematics ────────────────────────────────────────────────────
const float L1     = 90.0f;   // shoulder → elbow (mm)
const float L2     = 90.0f;   // elbow → wrist (mm)
const float L_END  = 97.0f;   // wrist → gripper tip (mm)
const float H_BASE = 77.0f;   // ground → shoulder pivot (mm)

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(PCA9685_ADDR);
WebSocketsClient webSocket;

// ── IK Solver ─────────────────────────────────────────────────────────
bool solveIK(float x, float y, float z, float pitch_deg,
             float& s_base, float& s_shld, float& s_elbow, float& s_wrist) {
    const float DEG = 180.0f / PI;
    const float RAD = PI / 180.0f;

    s_base = 90.0f - atan2f(y, x) * DEG;
    s_base = constrain(s_base, SERVO_LIMITS[J_BASE][0], SERVO_LIMITS[J_BASE][1]);

    float psi = pitch_deg * RAD;
    float R   = sqrtf(x*x + y*y);
    float r_w = R            - L_END * cosf(psi);
    float z_w = (z - H_BASE) - L_END * sinf(psi);

    float D2 = r_w*r_w + z_w*z_w;
    float D  = sqrtf(D2);

    if (D >= (L1 + L2) || D <= fabsf(L1 - L2)) {
        Serial.printf("[IK] Out of reach: D=%.1f\n", D);
        return false;
    }

    float cg   = constrain((L1*L1 + L2*L2 - D2) / (2.0f*L1*L2), -1.0f, 1.0f);
    float beta = PI - acosf(cg);
    float ca   = constrain((L1*L1 + D2 - L2*L2) / (2.0f*L1*D), -1.0f, 1.0f);
    float phi1 = atan2f(z_w, r_w) + acosf(ca);
    float phi2 = phi1 - beta;

    s_shld  = 180.0f - phi1 * DEG;
    s_elbow = beta   * DEG;
    s_wrist = 90.0f + (psi - phi2) * DEG;

    s_shld  = constrain(s_shld,  SERVO_LIMITS[J_SHOULDER][0], SERVO_LIMITS[J_SHOULDER][1]);
    s_elbow = constrain(s_elbow, SERVO_LIMITS[J_ELBOW][0],    SERVO_LIMITS[J_ELBOW][1]);
    s_wrist = constrain(s_wrist, SERVO_LIMITS[J_WRIST][0],    SERVO_LIMITS[J_WRIST][1]);

    Serial.printf("[IK] (%.0f,%.0f,%.0f) p=%.0f → b=%.1f s=%.1f e=%.1f w=%.1f\n",
                  x,y,z,pitch_deg, s_base,s_shld,s_elbow,s_wrist);
    return true;
}

// ── Servo control ─────────────────────────────────────────────────────
int angleToPWM(int angle) {
    angle = constrain(angle, 0, 180);
    int pulse_us = map(angle, 0, 180, SERVO_MIN_US, SERVO_MAX_US);
    return map(pulse_us, 0, 20000, 0, 4095);
}

void writeServo(int id, float angle) {
    pwm.setPWM(servoChannels[id], 0, angleToPWM((int)roundf(angle)));
}

void setServoAngle(int id, int angle) {
    if (id < 0 || id >= NUM_SERVOS) return;
    targetAngles[id] = constrain((float)angle,
                                  SERVO_LIMITS[id][0], SERVO_LIMITS[id][1]);
}

void sendState() {
    StaticJsonDocument<256> doc;
    doc["type"] = "state";
    JsonArray arr = doc.createNestedArray("angles");
    for (int i = 0; i < NUM_SERVOS; i++) arr.add((int)roundf(currentAnglesF[i]));
    String out; serializeJson(doc, out);
    webSocket.sendTXT(out);
}

// ── Smooth motion ─────────────────────────────────────────────────────
void updateServos() {
    static unsigned long lastMs     = 0;
    static unsigned long lastBcastMs = 0;
    static bool wasMoving = false;
    unsigned long now = millis();
    float dt = (float)(now - lastMs);
    if (dt < 1.0f) return;
    lastMs = now;

    bool anyMoving = false;
    float maxStep  = MOVE_SPEED_DEG_MS * dt;

    for (int i = 0; i < NUM_SERVOS; i++) {
        float diff = targetAngles[i] - currentAnglesF[i];
        if (fabsf(diff) < 0.05f) { currentAnglesF[i] = targetAngles[i]; continue; }
        float step = (diff > 0) ? min(maxStep, diff) : max(-maxStep, diff);
        currentAnglesF[i] += step;
        writeServo(i, currentAnglesF[i]);
        anyMoving = true;
    }

    if (anyMoving && (now - lastBcastMs >= 50)) {
        sendState(); lastBcastMs = now;
    } else if (!anyMoving && wasMoving) {
        sendState(); lastBcastMs = now;
    }
    wasMoving = anyMoving;
}

// ── WebSocket event handler ───────────────────────────────────────────
void onWebSocketEvent(WStype_t type, uint8_t* payload, size_t length) {
    switch (type) {

        case WStype_CONNECTED:
            Serial.printf("[WS] Connected to %s%s\n", SERVER_HOST, SERVER_PATH);
            sendState();
            break;

        case WStype_DISCONNECTED:
            Serial.println("[WS] Disconnected — will reconnect");
            break;

        case WStype_TEXT: {
            StaticJsonDocument<256> doc;
            if (deserializeJson(doc, payload)) break;
            const char* cmd = doc["type"];
            if (!cmd) break;

            if (strcmp(cmd, "ik_move") == 0) {
                float x = doc["x"]|0.0f, y = doc["y"]|0.0f,
                      z = doc["z"]|0.0f, p = doc["pitch"]|0.0f;
                float sb,ss,se,sw;
                if (solveIK(x,y,z,p,sb,ss,se,sw)) {
                    setServoAngle(J_BASE,     (int)roundf(sb));
                    setServoAngle(J_SHOULDER, (int)roundf(ss));
                    setServoAngle(J_ELBOW,    (int)roundf(se));
                    setServoAngle(J_WRIST,    (int)roundf(sw));
                } else {
                    StaticJsonDocument<128> err;
                    err["type"] = "error";
                    err["message"] = "Target out of reach";
                    String out; serializeJson(err, out);
                    webSocket.sendTXT(out);
                }
            } else if (strcmp(cmd, "move") == 0) {
                setServoAngle((int)doc["channel"], (int)doc["angle"]);
            } else if (strcmp(cmd, "move_all") == 0) {
                JsonArray a = doc["angles"];
                for (int i = 0; i < NUM_SERVOS && i < (int)a.size(); i++)
                    setServoAngle(i, (int)a[i]);
            } else if (strcmp(cmd, "get_state") == 0) {
                sendState();
            }
            break;
        }

        case WStype_PING:
            break;

        default:
            break;
    }
}

// ── WiFi helpers ──────────────────────────────────────────────────────
void connectWiFi() {
    Serial.printf("Connecting to WiFi: %s ", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASS);
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 40) {
        delay(500); Serial.print('.'); tries++;
    }
    if (WiFi.status() == WL_CONNECTED) {
        Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
    } else {
        Serial.println("\nWiFi failed — will retry in loop");
    }
}

// ── Setup ──────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);
    Serial.println("\n=== ESP32 Cloud Client ===");
    Serial.printf("Arm: L1=%.0f L2=%.0f L_END=%.0f H_BASE=%.0f mm\n", L1, L2, L_END, H_BASE);

    Wire.begin(I2C_SDA, I2C_SCL);
    pwm.begin();
    pwm.setOscillatorFrequency(27000000);
    pwm.setPWMFreq(50);
    delay(10);

    for (int i = 0; i < NUM_SERVOS; i++) { writeServo(i, currentAnglesF[i]); delay(50); }
    Serial.println("Servos initialised at 90°");

    connectWiFi();

    Serial.printf("Connecting to WebSocket: %s://%s:%d%s\n",
                  SERVER_SSL ? "wss" : "ws", SERVER_HOST, SERVER_PORT, SERVER_PATH);

    if (SERVER_SSL) {
        webSocket.beginSSL(SERVER_HOST, SERVER_PORT, SERVER_PATH);
    } else {
        webSocket.begin(SERVER_HOST, SERVER_PORT, SERVER_PATH);
    }

    webSocket.onEvent(onWebSocketEvent);
    webSocket.setReconnectInterval(5000);
    webSocket.enableHeartbeat(15000, 3000, 2);

    Serial.println("Setup complete — waiting for server connection...");
}

// ── Loop ───────────────────────────────────────────────────────────────
void loop() {
    if (WiFi.status() != WL_CONNECTED) {
        static unsigned long lastWiFiRetry = 0;
        if (millis() - lastWiFiRetry > 10000) {
            lastWiFiRetry = millis();
            Serial.println("[WiFi] Reconnecting...");
            WiFi.reconnect();
        }
    }

    webSocket.loop();
    updateServos();
}
