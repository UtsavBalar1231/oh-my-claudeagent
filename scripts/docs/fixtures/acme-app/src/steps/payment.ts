export const paymentStep = (declined?: string) => ({ title: "Payment", keepCart: true, alert: declined ?? null });
