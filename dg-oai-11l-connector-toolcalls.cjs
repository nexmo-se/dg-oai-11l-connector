'use strict'

//-------------

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser')
const webSocket = require('ws');
const axios = require('axios');
const app = express();
require('express-ws')(app);

app.use(bodyParser.json());

const fsp = require('fs').promises;
const moment = require('moment');

// const axios = require('axios');

//---- CORS policy - Update this section as needed ----

app.use(function (req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  res.header("Access-Control-Allow-Methods", "OPTIONS,GET,POST,PUT,DELETE");
  res.header("Access-Control-Allow-Headers", "Content-Type, Access-Control-Allow-Headers, Authorization, X-Requested-With");
  next();
});

//--- Record all audio ? --

let recordAllAudio = false;
if (process.env.RECORD_ALL_AUDIO == "true") { recordAllAudio = true };

//--- Streaming timer - Audio packets to Vonage ---

// const timer = 19; // in ms, actual timer duration is higher
const timer = 18; // in ms, actual timer duration is higher

//---- DeepGram ASR engine ----

const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
// const fetch = require("cross-fetch");
const dgApiKey = process.env.DEEPGRAM_API_KEY;

//---- OpenAI Chat engine ----

const OpenAI = require("openai");
const oaiKey = process.env.OPENAI_API_KEY;
const oaiModel = process.env.OPENAI_MODEL;
const oaiSystemMessage = process.env.OPENAI_SYSTEM_MESSAGE;

//---- ElevenLabs TTS engine ----

const elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
const elevenLabsVoiceId = process.env.ELEVENLABS_VOICE_ID;
const elevenLabsModel = process.env.ELEVENLABS_MODEL;

const elevenLabsInactivityTimer = 180; // in seconds, 180 max, default is 20
const elevenLabsKeepAliveTimer = 150000; // in milliseconds, must be less than elevenLabsInactivityTimer value

//--- Unhandled rejections/exceptions ---

process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled promise rejection (caught by safety net):", reason);
    // Log but do NOT call process.exit() — keeps the app running
});

process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught exception:", err);
    // Optionally restart or gracefully shut down here
});

//--- Streaming timer calculation ---

let prevTime = Date.now();
let counter = 0;
let total = 0;
let cycles = 2000;

console.log('\n>>> Wait around', Math.round(cycles * timer / 1000), 'seconds to see the actual streaming timer average ...\n');

const streamTimer = setInterval ( () => {
    
    const timeNow = Date.now();
    const difference = timeNow - prevTime;
    total = total + difference;
    prevTime = timeNow;

    counter++;

    if (counter == cycles) { 
        clearInterval(streamTimer);
        console.log('\n>>> Average streaming timer (should be close to 20 AND under 20.000):', total / counter);
    };

}, timer);

//--- OpenAI-related functions ---

/**
 * Retries an async function with exponential backoff.
 * Only retries on transient 429 rate-limits, NOT on credit exhaustion or other errors.
 *
 * @param {() => Promise<T>} fn        - The async function to retry
 * @param {object}           options
 * @param {number}           options.maxRetries  - Max number of retry attempts (default: 4)
 * @param {number}           options.baseDelayMs - Initial delay in ms, doubles each attempt (default: 1000)
 * @param {number}           options.maxDelayMs  - Cap on delay between retries (default: 30000)
 * @returns {Promise<T>}
 */
async function withRetry(fn, { maxRetries = 4, baseDelayMs = 1000, maxDelayMs = 30000 } = {}) {
    let attempt = 0;

    while (true) {
        try {
            return await fn();
        } catch (err) {
            const isRateLimit = err instanceof OpenAI.APIError && err.status === 429;
            const isCreditExhausted = err?.code === "credit_balance_exhausted";
            const isRetryable = isRateLimit && !isCreditExhausted;

            if (!isRetryable || attempt >= maxRetries) {
                // Hard fail: not retryable, or out of attempts
                handleOpenAIError(err);
                throw err;
            }

            // Exponential backoff with jitter
            const jitter = Math.random() * 500;
            const delay = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);

            console.warn(
                `⚠️  OpenAI rate limit hit. Retrying in ${(delay / 1000).toFixed(1)}s... ` +
                `(attempt ${attempt + 1}/${maxRetries})`
            );

            await new Promise(res => setTimeout(res, delay));
            attempt++;
        }
    }
}

/**
 * Centralized OpenAI error handler — logs a clear message per error type.
 * @param {unknown} err
 */
function handleOpenAIError(err) {
    if (!(err instanceof OpenAI.APIError)) {
        console.error("❌ Unexpected error:", err);
        return;
    }

    switch (err.status) {
        case 429:
            if (err.code === "credit_balance_exhausted") {
                console.error(
                    "❌ OpenAI credit balance exhausted. Add credits at: " +
                    "https://platform.openai.com/settings/organization/billing/"
                );
            } else {
                console.error("❌ OpenAI rate limit: max retries exceeded.");
            }
            break;
        case 401:
            console.error("❌ OpenAI authentication failed. Check your API key.");
            break;
        case 500:
        case 503:
            console.error("❌ OpenAI server error. Try again later.");
            break;
        default:
            console.error(`❌ OpenAI API error [${err.status}]: ${err.message}`);
    }
}

//--

const oaiTools = [
  {
    "type": "function",
    "function": {
      "name": "connect_to_live_person",
      "description": "Call this tool when the user explicitly asks to speak to a human representative, sounds highly frustrated, has a complex request the AI cannot resolve, or the humam representative wants to get connected to the customer.",
      "parameters": {
        "type": "object",
        "properties": {
          "reason": {
            "type": "string",
            "description": "Brief summary of why the call is being transferred."
          }
        },
        "required": ["reason"]
      }
    }
  }
]

//=========================================================================

//--- Websocket server (for WebSockets from Vonage Voice API platform) ---

app.ws('/socket', async (ws, req) => {

  //-- debug only --
  let ttsSeq = 0;

  //-----

  const webhookBaseUrl = req.query.webhook_base_url || null; // base URL to make webhook calls to Voice API application, such as call transfer requests
  const sessionId = req.query.session || 'none'; // session id that ties related call legs (leg uuids)
  const participant = req.query.participant || 'none';  // e.g. "customer", "human_agent", "patient", "doctor", "nurse"

  let elevenLabsTimer;

  console.log('>>> WebSocket from Vonage platform')
  console.log('>>> webhook base URL:', webhookBaseUrl);
  console.log('>>> participant:', participant);

  let wsVgOpen = true; // WebSocket to Vonage ready for binary audio payload?

  let isDgPartialTranscript = false;
  let dgTranscript = ""; 

  let startSpeech = false;
  let dropTtsChunks = false;
  let newResponseStart = '';  // first sentence of OpenAI new streamed responsse

  //-- audio recording files -- 
  const audioToDgFileName = './recordings/' + sessionId + '_rec_to_dg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time
  const audioToVgFileName = './recordings/' + sessionId + '_rec_to_vg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time

  if (recordAllAudio) { 

    try {
      await fsp.writeFile(audioToDgFileName, '');
    } catch(e) {
      console.log("Error creating file", audioToDgFileName, e);
    }
    console.log('File created:', audioToDgFileName);

    try {
      await fsp.writeFile(audioToVgFileName, '');
    } catch(e) {
      console.log("Error creating file", audioToVgFileName, e);
    }
    console.log('File created:', audioToVgFileName);

  }

//-- stream audio to VG --

  let payloadToVg = Buffer.alloc(0);
  let streamToVgIndex = 0;
  let lastTime = Date.now();
  let nowTime;

  //-

  const streamTimer = setInterval ( () => {

    if (payloadToVg.length != 0) {

      const streamToVgPacket = Buffer.from(payloadToVg).subarray(streamToVgIndex, streamToVgIndex + 640);  // 640-byte packet for linear16 / 16 kHz
      streamToVgIndex = streamToVgIndex + 640;

      if (streamToVgPacket.length != 0) {
        if (wsVgOpen && streamToVgPacket.length == 640) {
            nowTime = Date.now();
            
            // console.log('>> interval:', nowTime - lastTime, 's');
            process.stdout.write(".");
            
            ws.send(streamToVgPacket);
            lastTime = nowTime;

            if (recordAllAudio) {
              try {
                fsp.appendFile(audioToVgFileName, streamToVgPacket, 'binary');
              } catch(error) {
                console.log("error writing to file", audioToVg2FileName, error);
              }
            }  

        };
      } else {
        streamToVgIndex = streamToVgIndex - 640; // prevent index from increasing for ever as it is beyond buffer current length
      }

    } 

  }, timer);

  //-- ElevenLabs connection ---

  let ws11LabsOpen = false; // WebSocket to ElevenLabs ready for binary audio payload?

  const elevenLabsWsUrl = "wss://api.elevenlabs.io/v1/text-to-speech/" + elevenLabsVoiceId + "/stream-input?model_id=" + elevenLabsModel + "&language_code=en&output_format=pcm_16000&auto_mode=true&inactivity_timeout=" + elevenLabsInactivityTimer;

  const elevenLabsWs = new webSocket(elevenLabsWsUrl, {
    headers: { "xi-api-key": elevenLabsApiKey },
  });

  //--

  elevenLabsWs.on('error', async (event) => {
    console.log('>>> ElevenLabs WebSocket error:', event);
  }); 

  //--

  elevenLabsWs.on('open', async () => {
    console.log('>>> WebSocket to ElevenLabs opened');

    const bosMessage = {
        "text": " ",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.8,
            "use_speaker_boost": false
        },
        "xi_api_key": elevenLabsApiKey
    };
    
    elevenLabsWs.send(JSON.stringify(bosMessage));
    
    ws11LabsOpen = true;

    elevenLabsTimer = setInterval ( () => {

      // send keepalive message
      if (ws11LabsOpen) {
        console.log('\n>>>', Date.now(), 'Sending keep alive to ElevenLabs');
        elevenLabsWs.send(JSON.stringify({text: " "}));
      }

    }, elevenLabsKeepAliveTimer);

  });

  //--
      
  elevenLabsWs.on('message', async(msg) =>  {

    const data = JSON.parse(msg.toString());

    if (data.audio) {
      
      const newAudioPayloadToVg = Buffer.from(data.audio, 'base64');

      // console.log('\n>>>', Date.now(), 'Received audio payload from ElevenLabs:', newAudioPayloadToVg.length, 'bytes');

      if (startSpeech) {
        dropTtsChunks = true;
      }

      if (wsVgOpen) {

        // console.log('\ndropTtsChunks:', dropTtsChunks);

        if (dropTtsChunks) {

          const textArray = data.alignment.chars;

          // take first 15 chars or less
          const textLength = Math.min(textArray.length, 15);

          let receivedTtsText = '';

          for (let i = 0; i < textLength; i++) {
            receivedTtsText = receivedTtsText + textArray[i];
          }

          if (newResponseStart != '') {

            const compareLength = Math.min(receivedTtsText.length, newResponseStart.slice(0, textLength).length); // sometimes one string has extra trailing space character

            if ( receivedTtsText.slice(0, compareLength) == newResponseStart.slice(0, compareLength) ) {
              dropTtsChunks = false;
              payloadToVg = Buffer.concat([payloadToVg, newAudioPayloadToVg]);
            } 

          } 

        } else {

        payloadToVg = Buffer.concat([payloadToVg, newAudioPayloadToVg]);
      
        }

      }
      
    } else {

      console.log(data);
    
    }

    // if (data.isFinal) {
    //     // the generation is complete
    // }
    
    // if (data.normalizedAlignment) {
    //     // use the alignment info if needed
    // }

  });

  //--

  elevenLabsWs.on('close', async (msg) => {

    clearInterval(elevenLabsTimer);
    
    ws11LabsOpen = false; // stop sending audio payload to 11L platform

    console.log('>>> ElevenLabs WebSocket closed')
  
  });

  //-- OpenAI connection ---

  const openAi = new OpenAI();

  //-- Deepgram connection ---

  const deepgramClient = createClient(dgApiKey);

  let deepgram = deepgramClient.listen.live({       
    model: "nova-2",
    smart_format: false,      
    language: "en-US",        
    encoding: "linear16",
    sample_rate: 16000,
    utterance_end_ms: 1000,
    interim_results: true
  });

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log(">>> WebSocket to DeepGram opened");

    deepgram.addListener(LiveTranscriptionEvents.Transcript, async (data) => {
      
      // console.log('\n>>>', Date.now(), 'Deepgram events:', JSON.stringify(data));

      if (data.type != "Results") {
        console.log('\n>>> Deepgram event:', JSON.stringify(data));  
      }

      const transcript = data.channel.alternatives[0].transcript;

      const transcriptFinal = data.is_final;
      const speechFinal = data.speech_final;

      //--

      if (transcript != "" && !isDgPartialTranscript) {  

        isDgPartialTranscript = true;
        
        // trigger barge-in
        payloadToVg = Buffer.alloc(0);  // reset stream buffer to VG
        streamToVgIndex = 0;  

        // flag used to decide sending or not OpenAI response chunks to ElevenLabs TTS
        startSpeech = true;

        // reset content
        newResponseStart = '';

      };  

      //--

      if (transcript != "" && transcriptFinal) {
        dgTranscript = dgTranscript + transcript; // concatenate new completed partial transcript
      }

      if (speechFinal) {
        isDgPartialTranscript = false;

        //--  send to OpenAI --

        if (dgTranscript != "") {

          console.log('\n>>>', Date.now(), 'Sending Deepgram transcript to OpenAI as request: "' + dgTranscript + '"');

          // const completion = await openAi.chat.completions.create({
          //     model: oaiModel,
          //     messages: [
          //         { role: "developer", content: oaiSystemMessage },
          //         {
          //             role: "user",
          //             content: dgTranscript,
          //         },
          //     ],
          //     stream: true
          // });

          try {

            const completion = await withRetry(() =>
              openAi.chat.completions.create({
                model: oaiModel,
                messages: [
                    { role: "developer", content: oaiSystemMessage },
                    { role: "user", content: dgTranscript },
                ],
                tools: oaiTools,
                tool_choice: "auto",
                stream: true,
                store: true,
                metadata: {
                  session: sessionId,
                  party: participant
                }
              })
            );

            dgTranscript = "";


            //-- this is with stream: false --
            // const oAiTextResponse = completion.choices[0].message.content;
            // console.log('\n>>> OpenAI response:', oAiTextResponse);
            // if (ws11LabsOpen) {
            //   console.log('\n\n>>>', Date.now(), 'Sending OpenAI response to ElevenLabs for TTS:\n', oAiTextResponse);
            //   elevenLabsWs.send(JSON.stringify({text: oAiTextResponse}));
            // }

            //-- this is with stream: true -- handle barge-in too ---
            console.log("\n");

            let oAiSentence = '';
            let oAiToolCalls = '';

            for await (const chunk of completion) {

              // console.log('\n>>> chunk:', chunk);
              // console.log('>>> chunk.choices[0]:', chunk.choices[0]);

              if (chunk.choices[0]?.delta?.content == '') {
                startSpeech = false;  // no barge-in yet when starting sending text to TTS engine
              }

              //-- send text to ElevenLabs 
              // if ( (chunk.choices[0]?.delta?.content != undefined) && (chunk.choices[0]?.delta?.content != '')) {
              if ( chunk.choices[0]?.delta?.content != undefined ) {

                if (startSpeech) {  // barge-in
                  
                  // flag used to drop remaining TTS response packets from previous request
                  dropTtsChunks = true;
                  
                  break;  // stop sending text response chunks to ElevenLabs
                }

       
                const oAiResponseChunk = chunk.choices[0]?.delta?.content;
                process.stdout.write(oAiResponseChunk);

                oAiSentence = oAiSentence + oAiResponseChunk;


                // faster response time for English
                // TBD: find possible end of sentence markers in other languages
                if (oAiResponseChunk == '.' || oAiResponseChunk == '?' || oAiResponseChunk == '!') {

                  if (newResponseStart == '') {
                    newResponseStart = oAiSentence; // set with first sentence of OpenAI response
                  }

                  elevenLabsWs.send(JSON.stringify({text: oAiSentence})); 
                  
                  oAiSentence = '';  
                  process.stdout.write('\n');      
                }
              
              }

              //--- end of text response stream from OpenAI 
              if (chunk.choices[0]?.delta?.content == undefined) {

                // in case no character '.', '?', or '!' was found, send sentence(s) to ElevenLabs
                if (oAiSentence != '') {

                  if (newResponseStart == '') {
                    newResponseStart = oAiSentence; // set with first sentence of OpenAI response
                  }
                  
                  elevenLabsWs.send(JSON.stringify({text: oAiSentence})); 
                  
                  oAiSentence = '';
                }    

                //-- can send OpenAI response chunks to ElevenLabs again
                startSpeech = false;     

              }

              //--- tool calls ---

              if (chunk.choices[0]?.delta?.tool_calls != undefined) {

                const utteranceFunction = chunk.choices[0]?.delta.tool_calls[0].function.arguments;

                oAiToolCalls = oAiToolCalls + JSON.stringify(utteranceFunction, null, 2);

              } 

              //--- end of tool calls messages --

              if (chunk.choices[0]?.finish_reason == "tool_calls") {

                const toolReason = oAiToolCalls.replace(/\\("|)|"/g, '\$1');

                console.log(">>> tool reason:", toolReason);

                console.log('>>> here - trigger webhook to voice app with the info from tool calls')
                // play tool reason to human agent

                // play announcement to customer - Not yet working at the moment
                // dropTtsChunks = true;
                // elevenLabsWs.send(JSON.stringify({text: "Transferring your call now to human agent, please wait."})); 

                console.log('>>> trigger webhook to voice app with the info from tool calls')
                // play tool reason to human agent
                const info = {
                  session: sessionId,
                  participant: participant,
                  toolReason: JSON.parse(toolReason)
                };

                console.log(">>> info:\n" + JSON.stringify(info));

                try {
                  const status = await axios.post(`${webhookBaseUrl}/transfer`, info,
                    {
                      headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                      }
                    });
                  // console.log("HTTP POST status:", status);
                } 
                catch (err) {
                  console.log("HTTP POST  error: ", err);
                }
              
              }

            } // closing bracket for await

          } catch (err) {
            // withRetry already logged the specific error — just prevent the crash
            console.error("❌ OpenAI call failed, skipping this transcript segment.");
            // Do NOT re-throw here — that would crash the process

            // check why this part is not working
            // startSpeech = true; 
            // elevenLabsWs.send(JSON.stringify({text: "Could not connect to LLM"})); 
          }  
        
        }  // closing bracket for if dgTranscript ...
      
      }

    });

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("\n>>> Deepgram WebSocket closed");
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error received");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning received");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: metadata received");
      console.log("ws: metadata sent to client");
      // ws.send(JSON.stringify({ metadata: data }));
      console.log(JSON.stringify({ metadata: data }));
    });
  
  });

  //---------------

  ws.on('message', async (msg) => {
    
    if (typeof msg === "string") {
    
      console.log(">>> Vonage Websocket message:", msg);
    
    } else {

      if (deepgram.getReadyState() === 1 /* OPEN */) {
        
        deepgram.send(msg);

        if (recordAllAudio) {
          try {
            fsp.appendFile(audioToDgFileName, msg, 'binary');
          } catch(error) {
            console.log("error writing to file", audioToDgFileName, error);
          }
        } 

      } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
        // console.log("ws: data couldn't be sent to deepgram");
        null
      } else {
        // console.log("ws: data couldn't be sent to deepgram");
        null
      }

    }

  });

  //--

  ws.on('close', async () => {

    wsVgOpen = false;
    console.log("\n>>> Vonage WebSocket closed");

    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
    console.log(">>> Deepgram WebSocket closed");

    elevenLabsWs.close(); // close WebSocket to ElevenLabs
  });

});

//--- If this application is hosted on VCR (Vonage Cloud Runtime) serverless infrastructure --------

app.get('/_/health', async(req, res) => {

  res.status(200).send('Ok');

});

//=========================================

const port = process.env.VCR_PORT || process.env.PORT || 6000;

app.listen(port, () => console.log(`Connector application listening on port ${port}`));

//------------

