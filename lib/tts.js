const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args));

async function synthesizeSpeech(text) {
  const region = process.env.AZURE_SPEECH_REGION;
  const key = process.env.AZURE_SPEECH_KEY;
  const voice = "en-US-JennyNeural"; // smooth, natural voice

  const ssml = `<speak version='1.0' xml:lang='en-US'>
    <voice name='${voice}'>${text}</voice>
  </speak>`;

  const resp = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-16khz-64kbitrate-mono-mp3",
      },
      body: ssml,
    }
  );
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

module.exports = { synthesizeSpeech };
