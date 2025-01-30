'use strict'

//-------------

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser')
const webSocket = require('ws');
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

//--- Websocket server (for WebSockets from Vonage Voice API platform) ---

app.ws('/socket', async (ws, req) => {

  const peerUuid = req.query.peer_uuid;
  let elevenLabsTimer;

  console.log('>>> WebSocket from Vonage platform')
  console.log('>>> peer call uuid:', peerUuid);

  let wsVgOpen = true; // WebSocket to Vonage ready for binary audio payload?

  let isDgPartialTranscript = false;
  let dgTranscript = "";  

  //-- audio recording files -- 
  const audioToDgFileName = './recordings/' + peerUuid + '_rec_to_dg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time
  const audioToVgFileName = './recordings/' + peerUuid + '_rec_to_vg_' + moment(Date.now()).format('YYYY_MM_DD_HH_mm_ss_SSS') + '.raw'; // using local time

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

      console.log('\n>>>', Date.now(), 'Received audio payload from ElevenLabs:', newAudioPayloadToVg.length, 'bytes');

      if(wsVgOpen) {
        payloadToVg = Buffer.concat([payloadToVg, newAudioPayloadToVg]);
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
      
      // console.log('\n>>> Deepgram events:', JSON.stringify(data));

      if (data.type != "Results") {
        console.log('\n>>> Deepgram event:', JSON.stringify(data));  
      }

      const transcript = data.channel.alternatives[0].transcript;

      const transcriptFinal = data.is_final;
      const speechFinal = data.speech_final;

      //--

      // if (transcript != "" && !transcriptFinal && !speechFinal && !isDgPartialTranscript) {
      if (transcript != "" && !isDgPartialTranscript) {  

        isDgPartialTranscript = true;
        
        // trigger barge-in
        payloadToVg = Buffer.alloc(0);  // reset stream buffer to VG
        streamToVgIndex = 0;  

      };  

      //--

      if (transcript != "" && transcriptFinal) {
        dgTranscript = dgTranscript + transcript; // concatenate new completed partial transcript
    
        if (speechFinal) {
          isDgPartialTranscript = false;

          //--  send to OpenAI --
          console.log('\n>>>', Date.now(), 'Sending Deepgram transcript to OpenAI as request:\n', dgTranscript);

          const completion = await openAi.chat.completions.create({
              model: oaiModel,
              messages: [
                  { role: "developer", content: oaiSystemMessage },
                  {
                      role: "user",
                      content: dgTranscript,
                  },
              ],
          });

          dgTranscript = "";

          const oAiTextResponse = completion.choices[0].message.content;
          // console.log('\n>>> OpenAI response:', oAiTextResponse);

          //-------------

          // send OpenAI reply to ElevenLabs

          if (ws11LabsOpen) {
            console.log('\n\n>>>', Date.now(), 'Sending OpenAI response to ElevenLabs for TTS:\n', oAiTextResponse);
            elevenLabsWs.send(JSON.stringify({text: oAiTextResponse}));
          }

        }
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

//--- If this application is hosted on VCR (Vonage Code Runtime) serverless infrastructure (aka Neru) --------

app.get('/_/health', async(req, res) => {

  res.status(200).send('Ok');

});

//=========================================

const port = process.env.NERU_APP_PORT || process.env.PORT || 6000;

app.listen(port, () => console.log(`Connector application listening on port ${port}`));

//------------

