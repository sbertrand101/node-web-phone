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

require("promisify-patch").patch();

let app = koa();
let server = http.createServer(app.callback());
let wss = new ws.Server({ server: server, path: "/smschat" });

let commands = {};


const APPLICATION_NAME = "web-sms-chat";

function getCatapultClient(message) {
  return new catapult.Client(message.auth.userId, message.auth.apiToken, message.auth.apiSecret);
}

function emit(socket, eventName, data) {
  socket.send(JSON.stringify({
    eventName: eventName,
    data: data
  }));
}


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
});


/**
 * Check auth data, balance and return phone number for messages
 */
commands["signIn"] = function*(message, socket){
   message.auth = message.data;
   let client = getCatapultClient(message);
   const applicationName = `web-sms-chat on ${socket.upgradeReq.headers.host}`;
   debug("Getting account's balance");
   let result = yield catapult.Account.get.bind(catapult.Account).promise(client);
   if(result.balance <= 0){
     throw new Error("You have no enough amount of money on your account");
   }
   debug("Getting application id");
   let applicationId = ((yield catapult.Application.list.bind(catapult.Application).promise(client, {size: 1000}))
    .filter(function(app){
      return app.name == applicationName;
    })[0] || {}).id;
   if(!applicationId){
      debug("Creating new application on Catapult");
      applicationId = (yield catapult.Application.create.bind(catapult.Application).promise(client, {
        name: applicationName,
        incomingMessageUrl: `http://${socket.upgradeReq.headers.host}/${message.auth.userId}/callback`
      })).id;
   }
   debug("Getting phone number");
   let phoneNumber = ((yield catapult.PhoneNumber.list.bind(catapult.PhoneNumber)
     .promise(client, {applicationId: applicationId, size: 1}))[0] || {}).number;
   if(!phoneNumber){
     debug("Reserving new phone number on Catapult");
     let number = ((yield catapult.AvailableNumber.searchLocal.bind(catapult.AvailableNumber)
      .promise(client, {city: "Cary", state: "NC", quantity: 1}))[0] || {}).number;
     yield catapult.PhoneNumber.create.bind(catapult.PhoneNumber).promise(client, {number: number, applicationId: applicationId});
     phoneNumber = number; 
   }
   socket.userId = message.auth.userId;
   return {
     phoneNumber: phoneNumber
   };  
};


/**
 * Send SMS/MMS
 */
commands["sendMessage"] = function*(message, socket){
  let client = getCatapultClient(message);
  debug("Sending a text message");
  return yield catapult.Message.create.bind(catapult.Message).promise(client, message.data);
};



//handle callbacks from catapult and SPA requests from browser
app.use(function*(next){
  if(this.request.method === "POST"){
    let m = /\/([\w\-\_]+)\/callback$/i.exec(this.request.path);
    if(m){
      let userId = m[1];
      debug("Handling Catapult callback for user Id %s", userId)
      let body = yield parse.json(this);      
      debug("Data from Catapult for %s: %j", userId, body);
      wss.clients.filter(function(c){ return c.userId === userId; }).forEach(function(client) {
        emit(client, "new-message", body);
      });
      this.body = "";
      return;
    }
  }
  //SPA support
  if(this.request.method === "GET" 
    && ["/index.html", "/config.js", "/app/", "/styles/", "/node_modules/"].filter(function(t){ return this.request.path.indexOf(t) >= 0; }.bind(this)).length === 0 
    && this.request.path !== "/"){
    this.status = 301;
    this.redirect("/");
    return;
  }
  yield next;
});

//handle frontend
app.use(koaStatic("./web-sms-chat-frontend"));

 server.listen(process.env.PORT || 3000, "0.0.0.0", function(err){
   if(err){
     console.error(err.message);
     return;
   }
   console.log("Ready (port: %s)",server.address().port);
 }); 