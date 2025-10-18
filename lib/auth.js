const uuidv4 = async () => (await import("uuid")).v4();
const fs = require("fs");
const path = require("path");
const DATA_FILE = path.join(__dirname, "../data/users.json");

function readUsers() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function writeUsers(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function verifyAccess(req, res) {
  const { deviceId } = req.body;
  let users = readUsers();
  if (!users[deviceId]) {
    users[deviceId] = { key: uuidv4(), created: Date.now() };
    writeUsers(users);
  }
  res.json({ accessKey: users[deviceId].key });
}

module.exports = { verifyAccess };
