#node-web-sms-chat

NodeJS backend for web-based chat application that features Catapult SMS and MMS capabilities.

##Build and run

```bash
# prepare backend

git clone --recursive git@github.com:BandwidthExamples/node-web-sms-chat.git

npm install

# prepare frontend

cd web-sms-chat-frontend

npm install

npm run build

# run the app

cd ..

PORT=3000 node index.js # you should open external access to this port (for example via ngrok) 

```

Open in browser your external url.
