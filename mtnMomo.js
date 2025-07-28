// mtnMomo.js
// MTN MoMo API integration module for Fx Cobra X Bot
// This module provides functions to initiate payments and check status using MTN MoMo API.
// NOTE: This is a basic implementation. You may need to adjust endpoints or headers for production use.

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';

const MOMO_BASE_URLS = {
  sandbox: 'https://sandbox.momodeveloper.mtn.com',
  production: 'https://proxy.momoapi.mtn.com'
};

function loadSettings() {
  try {
    const raw = fs.readFileSync('./momoSettings.json', 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    throw new Error('Failed to load MoMo settings: ' + e.message);
  }
}

export async function getApiToken(settings) {
  const url = `${MOMO_BASE_URLS[settings.environment]}/collection/token/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': settings.subscriptionKey,
      'Authorization': 'Basic ' + Buffer.from(`${settings.apiUser}:${settings.apiKey}`).toString('base64'),
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Failed to get MoMo API token');
  const data = await res.json();
  return data.access_token;
}

export async function requestPayment({ phone, amount, currency, externalId, payerMessage, payeeNote }, settings) {
  const token = await getApiToken(settings);
  const url = `${MOMO_BASE_URLS[settings.environment]}/collection/v1_0/requesttopay`;
  const referenceId = uuidv4();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Reference-Id': referenceId,
      'X-Target-Environment': settings.environment,
      'Ocp-Apim-Subscription-Key': settings.subscriptionKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      amount: amount.toString(),
      currency: currency || settings.currency,
      externalId: externalId || referenceId,
      payer: {
        partyIdType: 'MSISDN',
        partyId: phone
      },
      payerMessage: payerMessage || 'Order Payment',
      payeeNote: payeeNote || 'Order Payment'
    })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error('MoMo payment initiation failed: ' + err);
  }
  return {
    referenceId,
    paymentLink: `https://momodeveloper.mtn.com/collection/v1_0/requesttopay/${referenceId}`
  };
}

export async function getPaymentStatus(referenceId, settings) {
  const token = await getApiToken(settings);
  const url = `${MOMO_BASE_URLS[settings.environment]}/collection/v1_0/requesttopay/${referenceId}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'X-Target-Environment': settings.environment,
      'Ocp-Apim-Subscription-Key': settings.subscriptionKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error('Failed to get payment status');
  return await res.json();
}
