/* global Buffer */
/* global process */
"use strict";
const debug = require("debug")("server");
const ws = require("ws");
const co = require("co");
const parse = require("co-body");
const catapult = require("node-bandwidth");
const koa = require("koa");
const koaStatic = require("koa-static");
const http = require("http");
const formidable = require("koa-formidable");
const fs = require("fs");

require("promisify-patch").patch();

let app = koa();
let server = http.createServer(app.callback());
let wss = new ws.Server({ server: server, path: "/smschat" });

let commands = {};
let sipDomain = "";

let activeUsers = {};


const APPLICATION_NAME = "web-sms-chat";

/**
 * Return Catapult instance from websocket message
 */
function getCatapultClient(message) {
  return new catapult.Client(message.auth.userId, message.auth.apiToken, message.auth.apiSecret);
}

/**
 *  Return Catapult instance for active user by id
 */
function getCatapultClientByUserId(userId) {
  let user = activeUsers[userId];
  if (!user) {
    return null;
  }
  return new catapult.Client(userId, user.apiToken, user.apiSecret);
}

/**
 * Write data to websocket
 */
function emit(socket, eventName, data) {
  socket.send(JSON.stringify({
    eventName: eventName,
    data: data
  }));
}

/**
 * Return Catapult application id (and create it if need)
 */
function* getApplicationId(client, applicationName, message, socket) {
  let applicationId = ((yield catapult.Application.list.bind(catapult.Application).promise(client, { size: 1000 }))
    .filter(function (app) {
      return app.name == applicationName;
    })[0] || {}).id;
  if (!applicationId) {
    debug("Creating new application on Catapult");
    applicationId = (yield catapult.Application.create.bind(catapult.Application).promise(client, {
      name: applicationName,
      incomingMessageUrl: `http://${socket.upgradeReq.headers.host}/${message.auth.userId}/message/callback`,
      incomingCallUrl: `http://${socket.upgradeReq.headers.host}/${message.auth.userId}/call/callback`,
      autoAnswer: false
    })).id;
  }
  return applicationId;
}

/**
 * Return Catapult phone number (and create it if need)
 */
function* getPhoneNumber(client, applicationId) {
  let phoneNumber = ((yield catapult.PhoneNumber.list.bind(catapult.PhoneNumber)
    .promise(client, { applicationId: applicationId, size: 1 }))[0] || {}).number;
  if (!phoneNumber) {
    debug("Reserving new phone number on Catapult");
    let number = ((yield catapult.AvailableNumber.searchLocal.bind(catapult.AvailableNumber)
      .promise(client, { city: "Cary", state: "NC", quantity: 1 }))[0] || {}).number;
    yield catapult.PhoneNumber.create.bind(catapult.PhoneNumber).promise(client, { number: number, applicationId: applicationId });
    phoneNumber = number;
  }
  return phoneNumber;
}

/**
 * Return Catapult domain (and create if if need)  
 */
function* getDomain(client, domainName) {
  let domain = (yield catapult.Domain.list.bind(catapult.Domain).promise(client)).filter(d => d.name == domainName)[0];
  if (!domain) {
    debug("Creating new domain on Catapult");
    domain = yield catapult.Domain.create.bind(catapult.Domain).promise(client, { name: domainName });
  }
  return domain;
}

/**
 * Return Catapult SIP endpoint (and create it if need)
 */
function* getEndpoint(domain, phoneNumber, userName, applicationId, password) {
  let endpoint = (yield domain.getEndPoints.bind(domain).promise()).filter(e => e.name == userName)[0];
  if (!endpoint) {
    debug("Creating new endpoint on Catapult");
    endpoint = yield domain.createEndPoint.bind(domain).promise({
      name: userName,
      description: `WebSms sip account for number ${phoneNumber}`,
      domainId: domain.id,
      applicationId: applicationId,
      enabled: true,
      credentials: {
        password: password
      }
    });
  }
  return endpoint;
}

/**
 * Cancel all active callss for user
 */
function* hangUpCalls(client, user){
  let calls = yield Object.keys(user.activeCalls || {}).map(function(callId){
    return catapult.Call.get.bind(catapult.Call).promise(client, callId);
  });
  yield calls.filter(function(call){
    return call.state === "active";
  }).map(function(call){
    return call.hangUp.bind(call).promise();
  });
}



/**
 * Update activeUser data and store userId with socket instance
 */
function setUserData(socket, message){
  if(socket.userId){
    return;
  }
  debug("Set user's data for socket");
  socket.userId = message.auth.userId;
  let user = activeUsers[message.auth.userId] 
    || {apiToken: message.auth.apiToken, apiSecret: message.auth.apiSecret, counter: 0};
  user.counter ++;
  activeUsers[message.auth.userId] = user;
}



/**
 * Handle websocket requests
 */
wss.on("connection", function (socket) {
  debug("Connected new websocket client");
  socket.on("message", function (json) {
    debug("Received new message %s", json);
    let message = {};
    try {
      message = JSON.parse(json);
    }
    catch (err) {
      console.error("Invalid format of received data: %s", json);
      return;
    }
    let sendError = function (err) {
      emit(socket, `${message.command}.error.${message.id}`, err);
    }
    let handler = commands[message.command];
    if (!handler) {
      let error = `Command ${message.command} is not implemented`;
      console.error(error);
      sendError(error);
      return;
    }
    debug("Executing command %s with data %j", message.command, message.data)
    co(handler(message, socket)).then(function (result) {
      emit(socket, `${message.command}.success.${message.id}`, result);
    }, function (err) {
      sendError(err.message || err);
    });
  });

  socket.on("close", function () {
    debug("Closed websocket connection for %s", socket.userId);
    let user = activeUsers[socket.userId];
    if(user && (-- user.counter) === 0){
      debug("User %s has no active connections");
      co(hangUpCalls(getCatapultClientByUserId(socket.userId), user)).catch(function(err){
        debug("Error on hang up call: %s", err.message || err);
      });
      delete activeUsers[socket.userId]; //no active sessions for this user
    }
  });
});



/**
 * Check auth data, balance and return phone number for messages
 */
commands["signIn"] = function* (message, socket) {
  message.auth = message.data;
  let client = getCatapultClient(message);
  const applicationName = `web-sms-chat on ${socket.upgradeReq.headers.host}`;
  const domainName = socket.upgradeReq.headers.host.split(".")[0];
  debug("Getting account's balance");
  let result = yield catapult.Account.get.bind(catapult.Account).promise(client);
  if (result.balance <= 0) {
    throw new Error("You have no enough amount of money on your account");
  }
  debug("Getting application id");
  let applicationId = yield getApplicationId(client, applicationName, message, socket);
  debug("Getting phone number");
  let phoneNumber = yield getPhoneNumber(client, applicationId, message, socket);
  const userName = `chat-${phoneNumber.substr(1) }`;

  debug("Getting domain");
  let domain = yield getDomain(client, domainName);
  const password = domain.id.substr(3, 20);
  sipDomain = `${domainName}.bwapp.bwsip.io`;

  debug("Getting endpoint %s", userName);
  yield getEndpoint(domain, phoneNumber, userName, applicationId, password);

  setUserData(socket, message);
  return {
    phoneNumber: phoneNumber,
    userName: userName,
    password: password,
    domain: sipDomain
  };
};


/**
 * Get messages
 */
commands["getMessages"] = function* (message, socket) {
  let client = getCatapultClient(message);
  debug("Get messages");
  let messages = (yield catapult.Message.list.bind(catapult.Message).promise(client, { size: 1000, from: message.data.phoneNumber, direction: "out" }))
    .concat(yield catapult.Message.list.bind(catapult.Message).promise(client, { size: 1000, to: message.data.phoneNumber, direction: "in" }));
  messages.sort(function (m1, m2) {
    let time1 = new Date(m1.time);
    let time2 = new Date(m2.time);
    return Number(time1) - Number(time2);
  });
  setUserData(socket, message);
  return messages;
};



/**
 * Send a message
 */
commands["sendMessage"] = function* (message, socket) {
  let client = getCatapultClient(message);
  debug("Sending a  message");
  let result = yield catapult.Message.create.bind(catapult.Message).promise(client, message.data);
  setUserData(socket, message);
  return result;
};


/**
 * Callback from Catapult for calls
 */
function* processCallEvent(userId, body, baseUrl) {
  let client = getCatapultClientByUserId(userId);
  if (!client) {
    return;
  }
  switch (body.eventType) {
    case "incomingcall":
      yield processIncomingCall(client, body, userId, baseUrl);
      break;
    case "hangup":
      yield processHangup(client, body, userId);
      break;
  }
}


/**
 * Incoming calls
 */
function* processIncomingCall(client, body, userId, baseUrl) {
  if (body.tag) {
    return;
  }
  const regex = new RegExp("sip\:chat\-(\d+)@" + sipDomain);
  let toNumber = body.to;
  let fromNumber = body.from;
  let m = regex.exec(body.from);
  if (m) {
    //outgoing call from web ui
    fromNumber = `+${m[1]}`;
  }
  else {
    //incoming call
    fromNumber = body.to;
    toNumber = `sip:chat-${body.to.substr(1) }@${sipDomain}`
  }
  let currentCall = yield catapult.Call.get.bind(catapult.Call).promise(client, body.callId);
  yield currentCall.answerOnIncoming.bind(currentCall).promise();
  yield currentCall.playAudio.bind(currentCall).promise({
    fileUrl: `${baseUrl}/sounds/ring.mp3`,
    loopEnabled: true
  });
  let bridge = yield catapult.Bridge.create.bind(catapult.Bridge).promise(client, {
    callIds: [body.callId],
    bridgeAudio: true
  });
  let activeCalls = activeUsers[userId].activeCalls || {};
  activeCalls[body.callId] = bridge.id;
  activeUsers[userId].activeCalls = activeCalls;
  let anotherCall = yield catapult.Call.create.bind(catapult.Call).promise(client, {
    from: fromNumber,
    to: toNumber,
    bridgeId: bridge.id,
    callbackUrl: `${baseUrl}/${userId}/call/callback`,
    tag: body.callId
  });
  activeCalls[anotherCall.id] = bridge.id;
}


/**
 * Hang up
 */
function* processHangup(client, body, userId) {
  let activeCalls = activeUsers[userId].activeCalls || {};
  let bridgeId = activeCalls[body.callId];
  if (!bridgeId) {
    return;
  }
  let bridge = yield catapult.Bridge.get.bind(catapult.Bridge).promise(client, bridgeId);
  let calls = yield bridge.getCalls.bind(bridge).promise();
  for (let call of calls) {
    delete activeCalls[call.id];
    if (call.state === "active") {
      debug("Hangup another call");
      yield call.hangUp.bind(call).promise();
    }
  }
}



/**
 * Handle callbacks from catapult and SPA requests from browser
 */
app.use(function* (next) {
  debug("%s - %s", this.request.method, this.request.path);
  if (this.request.method === "POST") {
    let m = /\/([\w\-\_]+)\/(call|message)\/callback$/i.exec(this.request.path);
    if (m) {
      let userId = m[1];
      debug("Handling Catapult callback for user Id %s", userId)
      let body = yield parse.json(this);
      debug("Data from Catapult for %s: %j", userId, body);
      wss.clients.filter(function (c) { return c.userId === userId; }).forEach(function (client) {
        debug("Sending Catapult data to websocket client");
        emit(client, m[2], body);
      });
      if (m[2] == "call") {
        //call events
        yield processCallEvent(userId, body, "http://" + this.req.headers.host);
      }
      this.body = "";
      return;
    }
    if (this.request.path === "/upload") {
      debug("Uploading file");
      let file = (yield formidable.parse(this)).files.file;
      let fileName = `${Math.random().toString(36).substring(5) }-${file.name}`;
      let auth = JSON.parse(this.request.headers.authorization);
      yield catapult.Media.upload.bind(catapult.Media).promise(new catapult.Client(auth), fileName, file.path, file.type);
      yield fs.unlink.promise(file.path);
      this.body = { fileName: fileName };
      return;
    }
  }
  //SPA support
  if (this.request.method === "GET"
    && ["/index.html", "/config.js", "/app/", "/styles/", "/node_modules/", "/jspm_packages/", "/sounds/", "/vendor.js"].filter(function (t) { return this.request.path.indexOf(t) >= 0; }.bind(this)).length === 0
    && this.request.path !== "/") {
    this.status = 301;
    this.redirect("/");
    return;
  }
  yield next;
});

/**
 * Handle frontend
 */
app.use(koaStatic("web-sms-chat-frontend"));

server.listen(process.env.PORT || 3000, "0.0.0.0", function (err) {
  if (err) {
    console.error(err.message);
    return;
  }
  console.log("Ready (port: %s)", server.address().port);
});
