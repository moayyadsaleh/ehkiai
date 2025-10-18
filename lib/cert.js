const { jsPDF } = require("jspdf");

async function generateCertificate(name, level) {
  const pdf = new jsPDF();
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(24);
  pdf.text("Certificate of Completion", 40, 60);
  pdf.setFontSize(14);
  pdf.setFont("helvetica", "normal");
  pdf.text(
    `This certifies that ${name} has successfully completed the SpeakUp English Conversation Course at level ${level}.`,
    40,
    100,
    { maxWidth: 500 }
  );
  pdf.text(`Date: ${new Date().toLocaleDateString()}`, 40, 150);
  pdf.text("Instructor: SpeakUp AI Coach", 40, 170);
  return pdf.output("datauristring").split(",")[1];
}

module.exports = { generateCertificate };
