#!/bin/bash

# download frontend directly if need
[[  -d ./web-phone-frontend ]] || (wget https://github.com/BandwidthExamples/web-phone-frontend/releases/download/1.0/web-phone-frontend.zip -O web-phone-frontend.zip && mkdir web-phone-frontend && unzip -o web-phone-frontend.zip -d ./web-phone-frontend) || true

