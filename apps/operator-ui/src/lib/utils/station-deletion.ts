// SPDX-FileCopyrightText: 2026 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

interface StationHistory {
  transactionHistory?: { id: number }[];
  ocppMessages?: { id: number }[] | null;
}

export function stationDeletionBlockReason(station: StationHistory): string | undefined {
  if (station.transactionHistory == null || station.ocppMessages == null) {
    return 'Cannot delete a station without history evidence';
  }
  if (station.transactionHistory.length > 0) {
    return 'Cannot delete a station that has session history';
  }
  if (station.ocppMessages.length > 0) {
    return 'Cannot delete a station that has OCPP message history';
  }
  return undefined;
}
