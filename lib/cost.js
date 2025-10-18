const fs = require("fs");
const path = require("path");
const COST_FILE = path.join(__dirname, "../data/costs.log");

async function logCost(type, amount) {
  const entry = `${new Date().toISOString()} | ${type} | $${amount.toFixed(
    5
  )}\n`;
  fs.appendFileSync(COST_FILE, entry);
}

module.exports = { logCost };
