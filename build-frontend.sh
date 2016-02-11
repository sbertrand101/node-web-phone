#!/bin/bash


if [ -d ./.git ]; then
  # This is git working copy

  # extract submodule if need
  [[ "$(ls -A ./web-sms-chat-frontend)" ]] || (git submodule init && git submodule update) || true
else
  # download frontend directly if need (required for 1-click deploy on Heroku)
  [[ "$(ls -A ./web-sms-chat-frontend)" ]] || (wget https://github.com/BandwidthExamples/web-sms-chat-frontend/archive/develop.zip -O web-sms-chat-frontend.zip && unzip -o web-sms-chat-frontend.zip) || true
fi


cd ./web-sms-chat-frontend
npm install
npm run build
