export type BuyerRequiredField = 'full_name' | 'cpf' | 'birth_date' | 'gender' | 'phone' | 'city';

export type BuyerRequirementInput = {
  full_name: string;
  cpf: string;
  birth_date: string;
  gender: string;
  phone: string;
  city: string;
  privacyAlreadyAccepted: boolean;
  privacyAcceptedNow: boolean;
};

export function resolveBuyerRequirements(input: BuyerRequirementInput) {
  const missingRequiredData: BuyerRequiredField[] = [];
  if (!input.full_name.trim()) missingRequiredData.push('full_name');
  if (input.cpf.replace(/\D/g, '').length !== 11) missingRequiredData.push('cpf');
  if (!input.birth_date.trim()) missingRequiredData.push('birth_date');
  if (!input.gender.trim()) missingRequiredData.push('gender');
  if (input.phone.replace(/\D/g, '').length < 10) missingRequiredData.push('phone');
  if (!input.city.trim()) missingRequiredData.push('city');

  const missingConsent = !input.privacyAlreadyAccepted && !input.privacyAcceptedNow;
  const dataComplete = missingRequiredData.length === 0;
  const consentSatisfied = !missingConsent;

  return {
    missingRequiredData,
    missingConsent,
    dataComplete,
    consentSatisfied,
    canRevealCompleteData: dataComplete && consentSatisfied,
    canContinue: dataComplete && consentSatisfied,
  };
}
