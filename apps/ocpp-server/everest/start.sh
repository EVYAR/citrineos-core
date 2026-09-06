#!/bin/sh
# SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
#
# SPDX-License-Identifier: Apache-2.0

_OCPP_VERSION=$OCPP_VERSION
OCPP_VERSION_ENUM="OCPP201"
CHARGE_POINT_ID="${EVEREST_CHARGE_POINT_ID:-cp001}"
EVEREST_TARGET_URL="${EVEREST_TARGET_URL:-ws://host.docker.internal:8081/${CHARGE_POINT_ID}}"

case "$_OCPP_VERSION" in
  "1.6")
    OCPP_VERSION_ENUM="OCPP16"
    ;;
"2.0.1")
    OCPP_VERSION_ENUM="OCPP201"
    ;;
"2.1")
    OCPP_VERSION_ENUM="OCPP21"
    ;;
  *)
    # NOT in the list
    _OCPP_VERSION="2.0.1"
    OCPP_VERSION_ENUM="OCPP201"
    ;;
esac

echo $OCPP_VERSION_ENUM

if [ "$_OCPP_VERSION" != "1.6" ]; then
    #There are two different configs in Everest that default their settings that we need to override for Citrine.
    #The first is a temp file that may or may not be used by Everest, but to be safe we change the config there.
    #The second is the config used by Everest when setting up their image, and this is the primary driver for the configuration of the image.

    CONFIG="$(cat <<JSON
[{"configurationSlot": 1, "connectionData": {"messageTimeout": 30, "ocppCsmsUrl": "$EVEREST_TARGET_URL", "ocppInterface": "Wired0", "ocppTransport": "JSON", "ocppVersion": "$OCPP_VERSION_ENUM", "securityProfile": 1}}, {"configurationSlot": 2, "connectionData": {"messageTimeout": 30, "ocppCsmsUrl": "$EVEREST_TARGET_URL", "ocppInterface": "Wired0", "ocppTransport": "JSON", "ocppVersion": "$OCPP_VERSION_ENUM", "securityProfile": 2}}]
JSON
 )"

    chmod +x /tmp/config.json
    jq --argjson config "$CONFIG" '
    (.[] 
        | select(.name == "InternalCtrlr") 
        | .variables.NetworkConnectionProfiles.attributes.Actual
    ) = $config
    ' "/tmp/config.json" > /tmp/config_citrine.json && mv /tmp/config_citrine.json "/tmp/config.json"
    chmod -x /tmp/config.json

    chmod +x /ext/dist/share/everest/modules/OCPP201/component_config/standardized/InternalCtrlr.json
    jq --argjson config "$CONFIG" '
    (. 
        | .properties 
        | .NetworkConnectionProfiles 
        | .attributes[] 
        | select(.type == "Actual") 
        | .value
    ) = $config
    ' "/ext/dist/share/everest/modules/OCPP201/component_config/standardized/InternalCtrlr.json" \
    > /tmp/config_citrine_dist.json && mv /tmp/config_citrine_dist.json "/ext/dist/share/everest/modules/OCPP201/component_config/standardized/InternalCtrlr.json"
    chmod -x /ext/dist/share/everest/modules/OCPP201/component_config/standardized/InternalCtrlr.json

    # EVerest 2025.6.1 stores the OCPP 2.x identity in component JSON files.
    # Do not use the legacy SQLite device-model path.
    if [ "$CHARGE_POINT_ID" != "cp001" ]; then
        INTERNAL_CTRLR_CONFIG="/ext/dist/share/everest/modules/OCPP201/component_config/standardized/InternalCtrlr.json"
        SECURITY_CTRLR_CONFIG="/ext/dist/share/everest/modules/OCPP201/component_config/standardized/SecurityCtrlr.json"

        [ -f "$INTERNAL_CTRLR_CONFIG" ] && sed -i "s#cp001#${CHARGE_POINT_ID}#g" "$INTERNAL_CTRLR_CONFIG"
        [ -f "$SECURITY_CTRLR_CONFIG" ] && sed -i "s#cp001#${CHARGE_POINT_ID}#g" "$SECURITY_CTRLR_CONFIG"
    fi
fi

/entrypoint.sh
http-server /tmp/everest_ocpp_logs -p 8888 &

if [ "$_OCPP_VERSION" = "1.6" ]; then
    chmod +x /ext/build/run-scripts/run-sil-ocpp.sh
    sed -i "0,/127.0.0.1:8180\/steve\/websocket\/CentralSystemService\// s|127.0.0.1:8180/steve/websocket/CentralSystemService/|${EVEREST_TARGET_URL}|" /ext/dist/share/everest/modules/OCPP/config-docker.json
    if [ -n "$EVEREST_TARGET_URL" ]; then
        case "$EVEREST_TARGET_URL" in
            wss://*)
                sed -i 's/"SecurityProfile": [0-9]\+/"SecurityProfile": 2/' /ext/dist/share/everest/modules/OCPP/config-docker.json
                ;;
            ws://*)
                sed -i 's/"SecurityProfile": [0-9]\+/"SecurityProfile": 1/' /ext/dist/share/everest/modules/OCPP/config-docker.json
                ;;
        esac
    fi
    if [ "$EVEREST_DISABLE_ISO15118" = "true" ]; then
        awk '
        BEGIN { skip_module = 0; skip_hlc = 0 }
        {
            if ($0 ~ /^  iso15118_charger:/) {
                skip_module = 1
                next
            }

            if (skip_module == 1) {
                if ($0 ~ /^  [A-Za-z0-9_]+:/) {
                    skip_module = 0
                } else {
                    next
                }
            }

            if ($0 ~ /^      hlc:/) {
                skip_hlc = 1
                next
            }

            if (skip_hlc == 1) {
                if ($0 ~ /^      [A-Za-z0-9_]+:/ || $0 ~ /^  [A-Za-z0-9_]+:/) {
                    skip_hlc = 0
                } else {
                    next
                }
            }

            print
        }
        ' /ext/source/config/config-sil-ocpp.yaml > /tmp/config-sil-ocpp-noiso15118.yaml

        LD_LIBRARY_PATH=/ext/dist/lib:$LD_LIBRARY_PATH \
        PATH=/ext/dist/bin:$PATH \
        manager \
            --prefix /ext/dist \
            --conf /tmp/config-sil-ocpp-noiso15118.yaml
    else
        /ext/build/run-scripts/run-sil-ocpp.sh
    fi
else
    #Works for all 2.x versions
    rm /ext/dist/share/everest/modules/OCPP201/component_config/custom/EVSE_2.json
    rm /ext/dist/share/everest/modules/OCPP201/component_config/custom/Connector_2_1.json
    if [ "$EVEREST_ENABLE_PNC" = "true" ]; then
        chmod +x /ext/build/run-scripts/run-sil-ocpp201-pnc.sh
        /ext/build/run-scripts/run-sil-ocpp201-pnc.sh
    else
        chmod +x /ext/build/run-scripts/run-sil-ocpp201.sh
        /ext/build/run-scripts/run-sil-ocpp201.sh
    fi
fi
