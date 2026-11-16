// Set while the page signs the person out. Ending the session makes every open shape answer 401, and the shape error
// policy sends a 401 to the sign-in page: that navigation would stop the wipe of the device copy half way.
let signingOut = false;

export const markSigningOut = () => {
  signingOut = true;
};
export const isSigningOut = () => signingOut;
/** Test helper. */
export const resetSigningOut = () => {
  signingOut = false;
};
