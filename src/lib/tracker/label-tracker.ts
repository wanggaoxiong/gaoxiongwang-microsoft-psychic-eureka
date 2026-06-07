export type RegisterTrackingInput = {
  orderId: string;
  carrier: string;
  trackingNo: string;
};

export async function registerTracking(input: RegisterTrackingInput) {
  return {
    labelTrackerId: `lt_${input.orderId}_${input.trackingNo}`,
    status: 'registered'
  };
}
