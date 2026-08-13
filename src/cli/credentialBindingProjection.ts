interface NamedCredential {
  readonly name: string;
}

interface CredentialBinding {
  readonly credential_name: string;
  readonly name: string;
  readonly scope: string;
}

interface CredentialMember {
  readonly token_credential_name: string;
}

/**
 * Projects logical credential names onto private mount names before provisioning,
 * so Spawnfile grant authorization and target secret filenames share one identity.
 */
export const projectCredentialBindingNames = <
  Credential extends NamedCredential,
  Binding extends CredentialBinding,
  Member extends CredentialMember,
>(input: Readonly<{
  credentials: readonly Credential[];
  secret_bindings: readonly Binding[];
  world_members: readonly Member[];
}>): Readonly<{
  credentials: readonly Credential[];
  secret_bindings: readonly Binding[];
  world_members: readonly Member[];
}> => {
  const available = new Set(input.credentials.map(({ name }) => name));
  const aliases = new Map<string, string>();
  for (const binding of input.secret_bindings) {
    if (!available.has(binding.credential_name)
      || aliases.has(binding.credential_name)) {
      throw new TypeError("composed secret binding credential identity is invalid");
    }
    aliases.set(binding.credential_name, binding.name);
  }
  const credentials = input.credentials.map((credential) => Object.freeze({
    ...credential, name: aliases.get(credential.name) ?? credential.name,
  }));
  if (new Set(credentials.map(({ name }) => name)).size !== credentials.length) {
    throw new TypeError("composed secret binding credential alias collides");
  }
  const worldMembers = input.world_members.map((member) => Object.freeze({
    ...member,
    token_credential_name: aliases.get(member.token_credential_name)
      ?? member.token_credential_name,
  }));
  const secretBindings = input.secret_bindings.map((binding) => Object.freeze({
    ...binding, credential_name: binding.name,
  }));
  return Object.freeze({
    credentials: Object.freeze(credentials),
    secret_bindings: Object.freeze(secretBindings),
    world_members: Object.freeze(worldMembers),
  });
};
