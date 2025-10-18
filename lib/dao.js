const fs = require("fs");
const path = require("path");
const DATA_FILE = path.join(__dirname, "../data/users.json");

function readData() {
  if (!fs.existsSync(DATA_FILE)) return {};
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}
function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

async function saveUserProgress(name, progress) {
  const db = readData();
  db[name] = { ...(db[name] || {}), progress };
  saveData(db);
}

async function getUserProgress(name) {
  const db = readData();
  return db[name];
}

module.exports = { saveUserProgress, getUserProgress };
