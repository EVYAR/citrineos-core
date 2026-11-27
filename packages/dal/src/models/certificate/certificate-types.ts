// SPDX-FileCopyrightText: 2025 Contributors to the CitrineOS Project
//
// SPDX-License-Identifier: Apache-2.0

// Public DAL values need runtime enums for declaration-only consumers using
// verbatimModuleSyntax.
export enum SignatureAlgorithmEnumType {
  RSA = 'SHA256withRSA',
  ECDSA = 'SHA256withECDSA',
}

export enum CountryNameEnumType {
  US = 'US',
}
