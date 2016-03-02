#!/bin/bash

# download frontend directly if need
[[  -d ./web-sms-chat-frontend ]] || (wget https://github.com/BandwidthExamples/web-sms-chat-frontend/releases/download/v1.0.1-with-calls/web-sms-chat-frontend.zip -O web-sms-chat-frontend.zip && mkdir web-sms-chat-frontend && unzip -o web-sms-chat-frontend.zip -d ./web-sms-chat-frontend) || true

