const getCommandOutputCandidates = (error) => {
  const stdout = String(error?.stdout || "").trim();
  const stderr = String(error?.stderr || "").trim();
  const combined = [stdout, stderr].filter(Boolean).join("\n").trim();

  return [...new Set([combined, stdout, stderr].filter(Boolean))];
};

module.exports = {
  getCommandOutputCandidates,
};
