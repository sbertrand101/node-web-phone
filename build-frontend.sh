#!/bin/bash

# extract submodule if need or download it directly (required for 1-click deploy on Heroku)
[[ "$(ls -A ./web-sms-chat-frontend)" ]] || (git submodule init && git submodule update) || (wget https://github.com/BandwidthExamples/web-sms-chat-frontend/archive/develop.zip -O web-sms-chat-frontend.zip && unzip -o web-sms-chat-frontend.zip)

cd ./web-sms-chat-frontend
npm install
npm run build
