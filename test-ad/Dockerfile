# ============================================
# PrintHub — Test Active Directory (Samba AD DC)
# Gerçek bir Windows Server'a ihtiyaç duymadan, AD ile aynı şekilde
# konuşan bir Domain Controller ayağa kaldırır (LDAP, sAMAccountName,
# memberOf, gruplar...). SADECE GELİŞTİRME/TEST İÇİNDİR.
# ============================================
FROM debian:12-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        samba samba-ad-provision samba-dsdb-modules samba-vfs-modules \
        smbclient winbind ldap-utils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# LDAP (389) ve LDAPS (636)
EXPOSE 389 636

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
