export const address = {
  name: { required: true, error: "Enter the name on the parcel" },
  line1: { required: true, error: "Enter a street address" },
  postcode: { pattern: /^[A-Z0-9 -]{3,10}$/i, error: "Enter a valid postcode" },
};
