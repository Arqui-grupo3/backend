# Prowler · seguridad de la cuenta AWS

EnergyShark · ciudad REE · cubre RNF03 y el gate G05 de la E3.

Se corrió Prowler sobre la cuenta AWS del grupo (`088674918891`), se repararon 3 hallazgos de severidad media o superior y se volvió a correr para comprobarlo.

| Carpeta | Contenido |
| --- | --- |
| `inicial/` | Reporte inicial (HTML y CSV) |
| `evidencia/` | Capturas del después de cada reparación |
| `posterior/` | Reporte posterior (HTML y CSV) |

## 1. Reporte inicial

| | |
| --- | --- |
| Fecha | 23 de noviembre de 2026, 14:59 UTC |
| Herramienta | Prowler, desde AWS CloudShell con el usuario de la cuenta |
| Comando | `prowler aws --region us-east-2 us-east-1` |
| Regiones | `us-east-2` (Ohio: EC2, ECR, API Gateway) y `us-east-1` (servicios globales: IAM, CloudFront, Budgets) |
| Checks evaluados | 309 |
| Resultado | 156 PASS · 147 FAIL · 6 MANUAL |
| FAIL de severidad media o superior | 109 (4 críticos, 36 altos, 69 medios) |

Archivos: `inicial/prowler-output-088674918891-20261123145917.html` y `.csv`.

## 2. Hallazgos reparados

Se eligieron hallazgos que se reparan en la consola, sobre recursos estables (la cuenta, IAM y la configuración de EC2), y sin riesgo para el nodo en producción.

| # | Check | Severidad | Recurso | Riesgo que cierra | Qué se cambió | Evidencia |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `cloudtrail_multi_region_enabled` | Alta | Cuenta, `us-east-1` y `us-east-2` | No quedaba registro de las acciones sobre la cuenta: si alguien borraba un recurso o usaba una llave filtrada, no había forma de investigarlo | Registro de seguimiento `energyshark-trail`, multirregión, con eventos de administración de lectura y escritura, logs en un bucket S3 propio cifrado con SSE-S3 y validación de archivos habilitada | `evidencia/1-cloudtrail-antes.png`, `evidencia/1-cloudtrail-despues.png` |
| 2 | `ec2_ebs_default_encryption` | Alta | Cuenta, `us-east-2` | Los volúmenes y snapshots de EBS nuevos quedaban sin cifrar: un snapshot compartido o filtrado se podía leer tal cual | Cifrado de EBS por defecto habilitado en Ohio con la clave administrada `aws/ebs`. Aplica a los volúmenes nuevos; el disco de la EC2 actual no se modificó | `evidencia/2-ebs-antes.png`, `evidencia/2-ebs-despues.png` |
| 3 | `iam_password_policy_minimum_length_14` y otros 5 de la política de contraseñas | Media | Política de contraseñas de IAM | Las contraseñas de la consola no tenían requisitos: una contraseña corta o reutilizada da acceso a la consola con los permisos de ese usuario | Política personalizada: mínimo 14 caracteres, mayúscula, minúscula, número y símbolo; vencimiento a 90 días; no reutilizar las últimas 24 | `evidencia/3-password-policy-antes.png`, `evidencia/3-password-policy-despues.png` |

El hallazgo 3 resuelve seis checks de severidad media con un solo cambio: `iam_password_policy_minimum_length_14`, `_uppercase`, `_number`, `_symbol`, `_reuse_24` y `_expires_passwords_within_90_days_or_less`, además de `_lowercase` (baja). El hallazgo 1 resuelve también `cloudtrail_multi_region_enabled_logging_management_events` (baja) en las dos regiones.

## 3. Reporte posterior

| | |
| --- | --- |
| Fecha | _completar_ |
| Comando | `prowler aws --region us-east-2 us-east-1` |
| Checks evaluados | _completar_ |
| Resultado | _completar_ PASS · _completar_ FAIL · _completar_ MANUAL |
| FAIL de severidad media o superior | _completar_ |

| # | Check | Inicial | Posterior |
| --- | --- | --- | --- |
| 1 | `cloudtrail_multi_region_enabled` (`us-east-1` y `us-east-2`) | FAIL | _completar_ |
| 2 | `ec2_ebs_default_encryption` (`us-east-2`) | FAIL | _completar_ |
| 3 | `iam_password_policy_*` (7 checks) | FAIL | _completar_ |

Archivos: `posterior/prowler-output-088674918891-<fecha>.html` y `.csv`.

El reporte posterior se corre al final de la entrega, con los recursos de la saga ya desplegados (Lambdas, máquinas de estados, roles y tabla de tokens). Por eso puede mostrar hallazgos nuevos que no estaban en el inicial.
