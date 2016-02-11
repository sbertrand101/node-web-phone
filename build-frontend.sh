#!/bin/bash

# extract submodule if need (required for 1-click deploy on Heroku)
[[ "$(ls -A ./web-sms-chat-frontend)" ]] || (git submodule init && git submodule update)

cd ./web-sms-chat-frontend
npm install
npm run build
