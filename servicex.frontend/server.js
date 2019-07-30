/* eslint-disable no-unused-vars */

console.log('ServiceX REST API starting ... ');

// const fs = require('fs');

const express = require('express');
// const session = require('express-session');
const https = require('https');
const http = require('http');
// const rRequest = require('request');

const config = require('./config/config.json');

// const gConfig = JSON.parse(fs.readFileSync(`${secretsPath}globus-conf/globus-config.json`));
// const auth = Buffer.from(`${gConfig.CLIENT_ID}:${gConfig.CLIENT_SECRET}`).toString('base64');

console.log(config);

const app = express();
app.use(express.static('web'));

app.use(express.json()); // to support JSON-encoded bodies

const ES = require('./esBackend');

const backend = new ES(config);
// require('./utils/drequest')(app, config, backend);
// require('./utils/dpath')(app, config, backend);
// const usr = require('./utils/user')(app, config, backend);

function UpdateState(reqId, cState) {
  console.log(cState);
  if (cState.events_served > 0 && cState.status === 'Validated') {
    backend.ChangeStatus(reqId, 'Streaming', 'Started streaming at =date= <BR>');
  }
  if (cState.events_processed >= cState.events
    || cState.events_processed >= cState.dataset_events) {
    backend.ChangeStatus(reqId, 'Done', 'Done at =date=.');
    backend.ChangePathStatus(reqId, 'Done');
    return;
  }
  if (cState.events_served >= cState.events
    || cState.events_served >= cState.dataset_events) {
    backend.ChangePathStatus(reqId, 'Done');
  }
  if ((cState.events_served - cState.events_processed) > config.HWM
    && cState.status !== 'Paused') {
    backend.ChangeStatus(reqId, 'Paused', 'Paused at =date=.<BR>');
    backend.ChangePathStatus(reqId, 'Paused');
  }
  if ((cState.events_served - cState.events_processed) < config.LWM
    && cState.status === 'Paused') {
    backend.ChangeStatus(reqId, 'Streaming', 'Restarted at >date<.');
    backend.ChangePathStatus(reqId, 'Validated');
  }
}

app.get('/healthz', (_req, res) => {
  try {
    res.status(200).send('OK');
  } catch (err) {
    console.log('something wrong', err);
  }
});

app.get('/drequest/status/:status', async (req, res) => {
  const { status } = req.params;
  // console.log('getting a request in status: ', status);
  const request = await backend.GetReqInStatus(status);
  // console.log('sending back:', request);
  res.status(200).json(request);
});

app.get('/drequest/:reqId', async (req, res) => {
  const { reqId } = req.params;
  console.log('lookup request : ', reqId);
  const request = await backend.GetReq(reqId);
  res.status(200).json(request);
});

app.put('/drequest/status/:reqId/:status/:info?', async (req, res) => {
  const { reqId } = req.params;
  const { status } = req.params;
  let info = '';
  if (req.params.info) {
    info = req.params;
  }
  console.log('update request status: ', reqId, status, info);
  await backend.ChangeStatus(reqId, status, info);
  res.status(200).send('OK');
});

app.put('/drequest/events_served/:reqId/:events', (req, res) => {
  const { reqId } = req.params;
  let { events } = req.params;
  console.log('request: ', reqId, ' had ', events, 'events served.');

  events = parseInt(events, 10);
  backend.AddEvents(reqId, 'served', events);
  res.status(200).send('OK');
});

app.put('/drequest/events_processed/:reqId/:events', (req, res) => {
  const { reqId } = req.params;
  let { events } = req.params;
  console.log('request: ', reqId, ' had ', events, 'events processed.');

  events = parseInt(events, 10);
  backend.AddEvents(reqId, 'processed', events);
  res.status(200).send('OK');
});

app.put('/drequest/terminate/:reqId', async (req, res) => {
  const { reqId } = req.params;
  console.log(`request: ${reqId} will be terminated.`);
  backend.ChangeStatus(reqId, 'Terminated', 'User terminated.');
  backend.ChangePathStatus(reqId, 'Terminated');
  res.status(200).send('OK');
});

app.post('/drequest/create/', async (req, res) => {
  const data = req.body;
  console.log('post creating data request:', data);
  if (!data.name) {
    res.status(500).send('Bad request. Request name missing.');
    return;
  }
  if (!data.dataset) {
    res.status(500).send('Bad request. Dataset name missing.');
    return;
  }
  if (!data.columns) {
    res.status(500).send('Bad request. Columns missing.');
    return;
  }
  if (!data.events) {
    res.status(500).send('Bad request. Events missing.');
    return;
  }
  if (!data.userid) {
    res.status(500).send('Bad request. userid missing.');
    return;
  }
  if (!data.description) {
    data.description = null;
  }
  const reqId = await backend.CreateRequest(data);
  res.status(200).send(reqId);
});

app.post('/drequest/update/', async (req, res) => {
  const data = req.body;
  console.log('post updating data request:', data);
  const darequest = new module.DArequest();
  const found = await darequest.get(data.id);
  if (!found) {
    console.log(`request ${data.id} not found. Not updating.`);
    res.status(500).send('request not found.');
    return;
  }
  if (data.status) darequest.status = data.status;
  if (data.dataset) darequest.dataset = data.dataset;
  if (data.columns) darequest.columns = data.columns;
  if (data.events) darequest.events = data.events;
  if (data.dataset_size) darequest.dataset_size = data.dataset_size;
  if (data.dataset_events) darequest.dataset_events = data.dataset_events;
  if (data.dataset_files) darequest.dataset_files = data.dataset_files;
  if (data.info) darequest.info += data.info;
  if (data.kafka_lwm > -1) darequest.kafka_lwm = data.kafka_lwm;
  if (data.kafka_hwm > -1) darequest.kafka_hwm = data.kafka_hwm;
  if (data.redis_messages) darequest.redis_messages = data.redis_messages;
  if (data.redis_consumers) darequest.redis_consumers = data.redis_consumers;
  if (typeof data.pause_it !== 'undefined') {
    console.log('Pause is there.', data.pause_it, 'previous state', darequest.paused_transforms);
    if (data.pause_it === true && !darequest.paused_transforms) {
      console.log('REALLY PAUSING.');
      await darequest.pauseTransforms(true);
    }
    if (data.pause_it === false && darequest.paused_transforms) {
      console.log('REALLY UNPAUSING.');
      await darequest.pauseTransforms(false);
    }
  }
  await darequest.update();
  res.status(200).send('OK');
});

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).send(err.message);
});

if (config.HTTPS) {
  // const privateKey = fs.readFileSync(`${secretsPath}https-certs/servicex.key.pem`);
  // const certificate = fs.readFileSync(`${secretsPath}https-certs/servicex.cert.crt`);
  // const credentials = { key: privateKey, cert: certificate };
  // https.createServer(credentials, app).listen(443, () => {
  //   console.log('Your server is listening on port 443.');
  // });
} else {
  http.createServer(app).listen(80, () => {
    console.log('Your server is listening on port 80.');
  });
}