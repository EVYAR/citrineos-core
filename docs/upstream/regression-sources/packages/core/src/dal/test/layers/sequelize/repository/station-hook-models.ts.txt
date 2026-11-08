import { ChargingStationSecurityInfo } from '../../../../layers/sequelize/model/ChargingStationSecurityInfo.js';
import { OCPPMessage } from '../../../../layers/sequelize/model/OCPPMessage.js';
import { VariableAttribute } from '../../../../layers/sequelize/model/DeviceModel/VariableAttribute.js';
import { ChargingStationNetworkProfile } from '../../../../layers/sequelize/model/Location/ChargingStationNetworkProfile.js';
import { Connector } from '../../../../layers/sequelize/model/Location/Connector.js';
import { StatusNotification } from '../../../../layers/sequelize/model/Location/StatusNotification.js';
import { LatestStatusNotification } from '../../../../layers/sequelize/model/Location/LatestStatusNotification.js';
import { SetNetworkProfile } from '../../../../layers/sequelize/model/Location/SetNetworkProfile.js';
import { Evse } from '../../../../layers/sequelize/model/Location/Evse.js';
import { Transaction } from '../../../../layers/sequelize/model/TransactionEvent/Transaction.js';
import { VariableMonitoring } from '../../../../layers/sequelize/model/VariableMonitoring/VariableMonitoring.js';
import { EventData } from '../../../../layers/sequelize/model/VariableMonitoring/EventData.js';
import { DeleteCertificateAttempt } from '../../../../layers/sequelize/model/Certificate/DeleteCertificateAttempt.js';
import { InstalledCertificate } from '../../../../layers/sequelize/model/Certificate/InstalledCertificate.js';
import { InstallCertificateAttempt } from '../../../../layers/sequelize/model/Certificate/InstallCertificateAttempt.js';
import { ChargingStationSequence } from '../../../../layers/sequelize/model/ChargingStationSequence/ChargingStationSequence.js';
export const stationHookModels = [
  ChargingStationSecurityInfo,
  OCPPMessage,
  VariableAttribute,
  ChargingStationNetworkProfile,
  Connector,
  StatusNotification,
  LatestStatusNotification,
  SetNetworkProfile,
  Evse,
  Transaction,
  VariableMonitoring,
  EventData,
  DeleteCertificateAttempt,
  InstalledCertificate,
  InstallCertificateAttempt,
  ChargingStationSequence,
];
